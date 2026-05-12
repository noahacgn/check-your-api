import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

type Model = {
  id: string;
  owned_by?: string;
  object?: string;
};

type ModelsResponse = {
  data?: Model[];
};

type CheckStatus = "idle" | "checking" | "available" | "unavailable";
type ModelFetchStatus = "idle" | "loading" | "loaded" | "failed";
type ProbeMode = "multiKey" | "multiBaseUrl";
type ResultFilter = "all" | "available" | "unavailable" | "pending";
type FieldName = "baseUrl" | "baseUrls" | "apiKey" | "apiKeys" | "concurrency" | "prompt";
type FieldErrors = Partial<Record<FieldName, string>>;
type InputElement = HTMLInputElement | HTMLTextAreaElement;

type ProbeEntry = {
  id: string;
  mode: ProbeMode;
  baseUrl: string;
  apiKey: string;
  label: string;
  displayLabel: string;
  modelFetchStatus: ModelFetchStatus;
  modelFetchError: string | null;
  modelIds: string[];
};

type ProbeResult = {
  columnId: string;
  modelId: string;
  status: CheckStatus;
  firstTokenLatencyMs: number | null;
  errorMessage: string | null;
};

type ProbeTask = {
  columnId: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
};

type CheckResponse = {
  available: true;
  firstTokenLatencyMs: number | null;
};

type LatencyLevel = "fast" | "medium" | "slow" | "unknown";

const STORAGE_KEY = "check-your-api-form";
const PROXY_ERROR_MESSAGE =
  "连不上当前站点的 API 服务。开发环境先运行 `npm run dev`，生产环境确认服务已经正常部署。";
const FAST_FIRST_TOKEN_MS = 800;
const MEDIUM_FIRST_TOKEN_MS = 2000;
const LARGE_TASK_WARNING_THRESHOLD = 100;
const fieldOrder: FieldName[] = [
  "baseUrl",
  "baseUrls",
  "apiKey",
  "apiKeys",
  "concurrency",
  "prompt"
];

const defaultForm = {
  mode: "multiKey" as ProbeMode,
  baseUrl: "",
  baseUrls: "",
  concurrency: "5",
  prompt: "Hi"
};

function isProbeMode(value: unknown): value is ProbeMode {
  return value === "multiKey" || value === "multiBaseUrl";
}

function loadStoredForm() {
  const stored = localStorage.getItem(STORAGE_KEY);

  if (!stored) {
    return defaultForm;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<typeof defaultForm> & {
      apiKey?: unknown;
    };

    const nextForm = {
      mode: isProbeMode(parsed.mode) ? parsed.mode : "multiKey",
      baseUrl: parsed.baseUrl ?? "",
      baseUrls: parsed.baseUrls ?? "",
      concurrency: parsed.concurrency ?? "5",
      prompt: parsed.prompt ?? "Hi"
    };

    if ("apiKey" in parsed) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextForm));
    }

    return nextForm;
  } catch {
    return defaultForm;
  }
}

function normalizeBaseUrl(url: string) {
  return url.trim().replace(/\/+$/, "");
}

function parseApiKeys(value: string) {
  const seen = new Set<string>();
  const apiKeys: string[] = [];

  for (const rawLine of value.split(/\r?\n/)) {
    const apiKey = rawLine.trim();

    if (!apiKey || seen.has(apiKey)) {
      continue;
    }

    seen.add(apiKey);
    apiKeys.push(apiKey);
  }

  return apiKeys;
}

function parseBaseUrls(value: string) {
  const seen = new Set<string>();
  const baseUrls: string[] = [];
  let duplicateCount = 0;
  let invalidCount = 0;
  let nonEmptyCount = 0;

  for (const rawLine of value.split(/\r?\n/)) {
    const baseUrl = normalizeBaseUrl(rawLine);

    if (!baseUrl) {
      continue;
    }

    nonEmptyCount += 1;

    if (!isValidUrl(baseUrl)) {
      invalidCount += 1;
      continue;
    }

    if (seen.has(baseUrl)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(baseUrl);
    baseUrls.push(baseUrl);
  }

  return {
    baseUrls,
    duplicateCount,
    invalidCount,
    nonEmptyCount
  };
}

function maskApiKey(apiKey: string) {
  if (apiKey.length <= 6) {
    return "******";
  }

  const prefix = apiKey.startsWith("sk-") ? "sk-" : apiKey.slice(0, 4);
  return `${prefix}...${apiKey.slice(-4)}`;
}

function getBaseUrlDisplayLabel(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "");

    return `${url.host}${pathname && pathname !== "/" ? pathname : ""}`;
  } catch {
    return baseUrl;
  }
}

function createApiKeyEntries(apiKeys: string[], baseUrl: string): ProbeEntry[] {
  return apiKeys.map((apiKey, index) => {
    const label = `Key ${index + 1}`;

    return {
      id: `key-${index + 1}`,
      mode: "multiKey",
      baseUrl,
      apiKey,
      label,
      displayLabel: `${label} · ${maskApiKey(apiKey)}`,
      modelFetchStatus: "idle",
      modelFetchError: null,
      modelIds: []
    };
  });
}

function createBaseUrlEntries(baseUrls: string[], apiKey: string): ProbeEntry[] {
  return baseUrls.map((baseUrl, index) => {
    const label = `Endpoint ${index + 1}`;

    return {
      id: `endpoint-${index + 1}`,
      mode: "multiBaseUrl",
      baseUrl,
      apiKey,
      label,
      displayLabel: `${label} · ${getBaseUrlDisplayLabel(baseUrl)}`,
      modelFetchStatus: "idle",
      modelFetchError: null,
      modelIds: []
    };
  });
}

function fuzzyMatch(value: string, query: string) {
  const source = value.trim().toLowerCase();
  const keyword = query.trim().toLowerCase();

  if (!keyword) {
    return true;
  }

  if (source.includes(keyword)) {
    return true;
  }

  let keywordIndex = 0;

  for (const char of source) {
    if (char === keyword[keywordIndex]) {
      keywordIndex += 1;
    }

    if (keywordIndex === keyword.length) {
      return true;
    }
  }

  return false;
}

function getLatencyLevel(latencyMs: number | null): LatencyLevel {
  if (typeof latencyMs !== "number") {
    return "unknown";
  }

  if (latencyMs <= FAST_FIRST_TOKEN_MS) {
    return "fast";
  }

  if (latencyMs <= MEDIUM_FIRST_TOKEN_MS) {
    return "medium";
  }

  return "slow";
}

function parseConcurrency(value: string) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "未知错误";
}

function isModelsResponse(payload: unknown): payload is ModelsResponse {
  return typeof payload === "object" && payload !== null && "data" in payload;
}

function isValidUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getStatusLabel(status?: CheckStatus) {
  if (status === "checking") {
    return "检测中";
  }

  if (status === "available") {
    return "可用";
  }

  if (status === "unavailable") {
    return "不可用";
  }

  return "待检测";
}

function matchesResultFilter(status: CheckStatus, filter: ResultFilter) {
  if (filter === "all") {
    return true;
  }

  if (filter === "pending") {
    return status === "idle" || status === "checking";
  }

  return status === filter;
}

function getFetchStatusLabel(status: ModelFetchStatus) {
  if (status === "loading") {
    return "拉取中";
  }

  if (status === "loaded") {
    return "已拉取";
  }

  if (status === "failed") {
    return "失败";
  }

  return "未拉取";
}

function getProbeResultKey(columnId: string, modelId: string) {
  return `${columnId}::${modelId}`;
}

function isModelListedByEntry(entry: ProbeEntry, modelId: string) {
  return entry.modelIds.includes(modelId);
}

function buildRoundRobinTasks(entries: ProbeEntry[], selectedModels: Model[]): ProbeTask[] {
  const queues = entries.map((entry) =>
    selectedModels
      .filter((model) => isModelListedByEntry(entry, model.id))
      .map((model) => ({
        columnId: entry.id,
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey,
        modelId: model.id
      }))
  );
  const tasks: ProbeTask[] = [];
  const maxQueueLength = Math.max(0, ...queues.map((queue) => queue.length));

  for (let index = 0; index < maxQueueLength; index += 1) {
    for (const queue of queues) {
      const task = queue[index];

      if (task) {
        tasks.push(task);
      }
    }
  }

  return tasks;
}

function getRawNonEmptyLineCount(value: string) {
  return value.split(/\r?\n/).filter((line) => line.trim()).length;
}

async function parseJsonSafe(response: Response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function requestProxy<T>(path: string, body: Record<string, unknown>) {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const payload = await parseJsonSafe(response);

    if (!response.ok) {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof (payload as { error?: unknown }).error === "string"
      ) {
        throw new Error((payload as { error: string }).error);
      }

      throw new Error(
        typeof payload === "string" ? payload : `本地代理请求失败，HTTP ${response.status}`
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(PROXY_ERROR_MESSAGE);
    }

    throw error;
  }
}

export default function App() {
  const [form, setForm] = useState(loadStoredForm);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeysInput, setApiKeysInput] = useState("");
  const [probeEntries, setProbeEntries] = useState<ProbeEntry[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [checkingModels, setCheckingModels] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showColumnDetails, setShowColumnDetails] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  const fieldRefs = useRef<Record<FieldName, InputElement | null>>({
    baseUrl: null,
    baseUrls: null,
    apiKey: null,
    apiKeys: null,
    concurrency: null,
    prompt: null
  });
  const modelFetchRunId = useRef(0);
  const checkRunId = useRef(0);

  const resolvedBaseUrl = useMemo(() => normalizeBaseUrl(form.baseUrl), [form.baseUrl]);
  const parsedBaseUrls = useMemo(() => parseBaseUrls(form.baseUrls), [form.baseUrls]);
  const resolvedApiKey = useMemo(() => apiKeyInput.trim(), [apiKeyInput]);
  const parsedApiKeys = useMemo(() => parseApiKeys(apiKeysInput), [apiKeysInput]);
  const duplicateKeyCount = useMemo(
    () => Math.max(0, getRawNonEmptyLineCount(apiKeysInput) - parsedApiKeys.length),
    [apiKeysInput, parsedApiKeys.length]
  );
  const isMultiBaseUrlMode = form.mode === "multiBaseUrl";
  const activeColumnLabel = isMultiBaseUrlMode ? "Endpoint" : "Key";
  const pendingColumnCount = isMultiBaseUrlMode
    ? parsedBaseUrls.baseUrls.length
    : parsedApiKeys.length;
  const selectedModelIdSet = useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const visibleModels = useMemo(
    () => models.filter((model) => selectedModelIdSet.has(model.id)),
    [models, selectedModelIdSet]
  );
  const visibleProbeablePairs = useMemo(
    () =>
      probeEntries.flatMap((entry) =>
        visibleModels
          .filter((model) => isModelListedByEntry(entry, model.id))
          .map((model) => ({
            columnId: entry.id,
            modelId: model.id
          }))
      ),
    [probeEntries, visibleModels]
  );
  const filteredPickerModels = useMemo(
    () =>
      models.filter(
        (model) =>
          fuzzyMatch(model.id, modelSearchQuery) ||
          fuzzyMatch(model.owned_by ?? "", modelSearchQuery)
      ),
    [models, modelSearchQuery]
  );

  const totalTaskCount = visibleProbeablePairs.length;
  const visibleResultValues = useMemo(
    () =>
      visibleProbeablePairs
        .map((pair) => probeResults[getProbeResultKey(pair.columnId, pair.modelId)])
        .filter((result): result is ProbeResult => Boolean(result)),
    [probeResults, visibleProbeablePairs]
  );
  const availableCount = useMemo(
    () => visibleResultValues.filter((result) => result.status === "available").length,
    [visibleResultValues]
  );
  const unavailableCount = useMemo(
    () => visibleResultValues.filter((result) => result.status === "unavailable").length,
    [visibleResultValues]
  );
  const checkingCount = useMemo(
    () => visibleResultValues.filter((result) => result.status === "checking").length,
    [visibleResultValues]
  );
  const checkedCount = availableCount + unavailableCount;
  const pendingCount = Math.max(0, totalTaskCount - checkedCount);
  const progressValue = totalTaskCount > 0 ? checkedCount / totalTaskCount : 0;
  const loadedEntryCount = probeEntries.filter(
    (entry) => entry.modelFetchStatus === "loaded"
  ).length;
  const failedEntryCount = probeEntries.filter(
    (entry) => entry.modelFetchStatus === "failed"
  ).length;
  const scaleWarning =
    totalTaskCount > LARGE_TASK_WARNING_THRESHOLD
      ? `本次会产生 ${totalTaskCount} 个探测任务。建议先降低模型数或并发数。`
      : "";

  const getResultForCell = (columnId: string, modelId: string) =>
    probeResults[getProbeResultKey(columnId, modelId)];

  const getProbeStatus = (columnId: string, modelId: string): CheckStatus =>
    getResultForCell(columnId, modelId)?.status ?? "idle";

  const filterCounts: Record<ResultFilter, number> = {
    all: totalTaskCount,
    available: visibleProbeablePairs.filter(
      (pair) => getProbeStatus(pair.columnId, pair.modelId) === "available"
    ).length,
    unavailable: visibleProbeablePairs.filter(
      (pair) => getProbeStatus(pair.columnId, pair.modelId) === "unavailable"
    ).length,
    pending: visibleProbeablePairs.filter((pair) =>
      matchesResultFilter(getProbeStatus(pair.columnId, pair.modelId), "pending")
    ).length
  };

  const displayedProbeGroups = useMemo(
    () =>
      probeEntries.map((entry) => {
        const items = visibleModels
          .filter((model) => isModelListedByEntry(entry, model.id))
          .map((model) => {
            const result = getResultForCell(entry.id, model.id);
            const status = result?.status ?? "idle";

            return {
              model,
              result,
              status,
              latencyLevel: getLatencyLevel(result?.firstTokenLatencyMs ?? null)
            };
          });
        const availableInGroup = items.filter((item) => item.status === "available").length;
        const unavailableInGroup = items.filter((item) => item.status === "unavailable").length;
        const checkedInGroup = availableInGroup + unavailableInGroup;

        return {
          entry,
          items: items.filter((item) => matchesResultFilter(item.status, resultFilter)),
          totalCount: items.length,
          checkedCount: checkedInGroup,
          pendingCount: Math.max(0, items.length - checkedInGroup),
          availableCount: availableInGroup,
          unavailableCount: unavailableInGroup
        };
      }),
    [probeEntries, probeResults, resultFilter, visibleModels]
  );

  const statusHeadline = useMemo(() => {
    if (checkingModels) {
      return `正在检测 ${checkedCount}/${totalTaskCount}`;
    }

    if (fetchingModels) {
      return `正在拉取 ${loadedEntryCount + failedEntryCount}/${probeEntries.length}`;
    }

    if (models.length > 0) {
      return `已合并 ${models.length} 个模型`;
    }

    return "等待连接 API";
  }, [
    checkedCount,
    checkingModels,
    failedEntryCount,
    fetchingModels,
    loadedEntryCount,
    models.length,
    probeEntries.length,
    totalTaskCount
  ]);

  const statusDescription = useMemo(() => {
    if (isMultiBaseUrlMode) {
      if (parsedBaseUrls.baseUrls.length > 0) {
        return `Endpoint：${parsedBaseUrls.baseUrls.length} 个 Base URL`;
      }

      return "填写一枚 API Key，并逐行输入多个 Base URL。";
    }

    if (resolvedBaseUrl) {
      return `Endpoint：${resolvedBaseUrl}`;
    }

    return "填写同一个 Base URL 下的多枚 API Key。";
  }, [isMultiBaseUrlMode, parsedBaseUrls.baseUrls.length, resolvedBaseUrl]);

  useEffect(() => {
    if (!showModelPicker) {
      return;
    }

    const previousOverflow = document.body.style.overflow;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowModelPicker(false);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showModelPicker]);

  const persistForm = (nextForm: typeof form) => {
    setForm(nextForm);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextForm));
  };

  const clearFieldError = (field: FieldName) => {
    setFieldErrors((current) => {
      if (!current[field]) {
        return current;
      }

      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const resetFetchedData = () => {
    modelFetchRunId.current += 1;
    checkRunId.current += 1;
    setProbeEntries([]);
    setModels([]);
    setSelectedModelIds([]);
    setProbeResults({});
    setShowModelPicker(false);
    setShowColumnDetails(false);
    setModelSearchQuery("");
    setResultFilter("all");
  };

  const updateMode = (mode: ProbeMode) => {
    if (form.mode === mode) {
      return;
    }

    persistForm({
      ...form,
      mode
    });
    setFieldErrors({});
    setFetchError("");
    resetFetchedData();
  };

  const updateFormField = (
    field: "baseUrl" | "baseUrls" | "concurrency" | "prompt",
    value: string
  ) => {
    persistForm({
      ...form,
      [field]: value
    });
    clearFieldError(field);
    setFetchError("");

    if (field === "baseUrl" || field === "baseUrls") {
      resetFetchedData();
    }
  };

  const updateApiKeyField = (value: string) => {
    setApiKeyInput(value);
    clearFieldError("apiKey");
    setFetchError("");
    resetFetchedData();
  };

  const updateApiKeysField = (value: string) => {
    setApiKeysInput(value);
    clearFieldError("apiKeys");
    setFetchError("");
    resetFetchedData();
  };

  const focusFirstFieldError = (errors: FieldErrors) => {
    const firstField = fieldOrder.find((field) => errors[field]);

    if (!firstField) {
      return;
    }

    window.requestAnimationFrame(() => {
      fieldRefs.current[firstField]?.focus();
    });
  };

  const validateConnectionFields = () => {
    const nextErrors: FieldErrors = {};

    if (isMultiBaseUrlMode) {
      if (!resolvedApiKey) {
        nextErrors.apiKey = "API Key 不能为空。";
      }

      if (parsedBaseUrls.nonEmptyCount === 0) {
        nextErrors.baseUrls = "至少输入一个 Base URL，每行一个。";
      } else if (parsedBaseUrls.invalidCount > 0) {
        nextErrors.baseUrls = "Base URL 列表包含无效地址，示例：https://example.com/v1";
      }
    } else {
      if (!resolvedBaseUrl) {
        nextErrors.baseUrl = "Base URL 不能为空。";
      } else if (!isValidUrl(resolvedBaseUrl)) {
        nextErrors.baseUrl = "Base URL 格式不对，示例：https://example.com/v1";
      }

      if (parsedApiKeys.length === 0) {
        nextErrors.apiKeys = "至少输入一枚 API Key，每行一枚。";
      }
    }

    return nextErrors;
  };

  const validateRuntimeFields = (includePrompt: boolean) => {
    const nextErrors: FieldErrors = {};

    if (!parseConcurrency(form.concurrency)) {
      nextErrors.concurrency = "并发数必须是大于 0 的整数。";
    }

    if (includePrompt && !form.prompt.trim()) {
      nextErrors.prompt = "请求内容不能为空。";
    }

    return nextErrors;
  };

  const syncValidationErrors = (nextErrors: FieldErrors, message: string) => {
    setFieldErrors(nextErrors);
    setFetchError(message);
    focusFirstFieldError(nextErrors);
  };

  const updateProbeResult = (
    columnId: string,
    modelId: string,
    patch: Partial<ProbeResult> & Pick<ProbeResult, "status">
  ) => {
    setProbeResults((current) => {
      const resultKey = getProbeResultKey(columnId, modelId);

      return {
        ...current,
        [resultKey]: {
          ...current[resultKey],
          columnId,
          modelId,
          firstTokenLatencyMs: null,
          errorMessage: null,
          ...patch
        }
      };
    });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void fetchModels();
  };

  const fetchModels = async () => {
    const nextErrors = {
      ...validateConnectionFields(),
      ...validateRuntimeFields(false)
    };

    if (Object.keys(nextErrors).length > 0) {
      syncValidationErrors(nextErrors, "先把连接信息填完整。");
      return;
    }

    const runId = modelFetchRunId.current + 1;
    modelFetchRunId.current = runId;
    checkRunId.current += 1;
    const nextProbeEntries = (
      isMultiBaseUrlMode
        ? createBaseUrlEntries(parsedBaseUrls.baseUrls, resolvedApiKey)
        : createApiKeyEntries(parsedApiKeys, resolvedBaseUrl)
    ).map((entry) => ({
      ...entry,
      modelFetchStatus: "loading" as const
    }));
    const modelsById = new Map<string, Model>();
    let successfulEntryCount = 0;
    let failedFetchCount = 0;
    const entryLabel = isMultiBaseUrlMode ? "Base URL" : "API Key";

    setFetchingModels(true);
    setFetchError("");
    setFieldErrors({});
    setProbeEntries(nextProbeEntries);
    setModels([]);
    setSelectedModelIds([]);
    setProbeResults({});
    setResultFilter("all");
    setShowColumnDetails(false);

    try {
      const queue = [...nextProbeEntries];
      const workerCount = Math.min(parseConcurrency(form.concurrency) ?? 1, queue.length);

      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (queue.length > 0) {
            const entry = queue.shift();

            if (!entry) {
              return;
            }

            try {
              const payload = await requestProxy<ModelsResponse>("/api/models", {
                baseUrl: entry.baseUrl,
                apiKey: entry.apiKey
              });
              const nextModels =
                isModelsResponse(payload) && Array.isArray(payload.data)
                  ? payload.data.filter(
                      (item: Model): item is Model => typeof item?.id === "string"
                    )
                  : [];

              successfulEntryCount += 1;

              for (const model of nextModels) {
                if (!modelsById.has(model.id)) {
                  modelsById.set(model.id, model);
                }
              }

              if (modelFetchRunId.current !== runId) {
                return;
              }

              setProbeEntries((current) =>
                current.map((currentEntry) =>
                  currentEntry.id === entry.id
                    ? {
                        ...currentEntry,
                        modelFetchStatus: "loaded",
                        modelFetchError: null,
                        modelIds: nextModels.map((model) => model.id)
                      }
                    : currentEntry
                )
              );
            } catch (error) {
              failedFetchCount += 1;

              if (modelFetchRunId.current !== runId) {
                return;
              }

              setProbeEntries((current) =>
                current.map((currentEntry) =>
                  currentEntry.id === entry.id
                    ? {
                        ...currentEntry,
                        modelFetchStatus: "failed",
                        modelFetchError: getErrorMessage(error),
                        modelIds: []
                      }
                    : currentEntry
                )
              );
            }
          }
        })
      );

      if (modelFetchRunId.current !== runId) {
        return;
      }

      const mergedModels = Array.from(modelsById.values()).sort((a, b) =>
        a.id.localeCompare(b.id)
      );

      setModels(mergedModels);
      setSelectedModelIds(mergedModels.map((model) => model.id));
      setShowModelPicker(false);
      setShowColumnDetails(false);
      setModelSearchQuery("");

      if (successfulEntryCount === 0) {
        setFetchError(`所有 ${entryLabel} 都没能拉取模型。请检查地址或密钥权限。`);
      } else if (mergedModels.length === 0) {
        setFetchError("接口返回成功，但没拿到任何模型。");
      } else if (failedFetchCount > 0) {
        setFetchError(`部分 ${entryLabel} 拉取模型失败，仍可继续检测已合并的模型。`);
      }
    } finally {
      if (modelFetchRunId.current === runId) {
        setFetchingModels(false);
      }
    }
  };

  const checkOneModel = async (baseUrl: string, apiKey: string, modelId: string) =>
    requestProxy<CheckResponse>("/api/check", {
      baseUrl,
      apiKey,
      model: modelId,
      prompt: form.prompt.trim()
    });

  const batchCheckModels = async () => {
    if (checkingModels) {
      return;
    }

    const nextErrors = {
      ...validateConnectionFields(),
      ...validateRuntimeFields(true)
    };

    if (Object.keys(nextErrors).length > 0) {
      syncValidationErrors(nextErrors, "先修正表单里的问题。");
      return;
    }

    if (probeEntries.length === 0 || models.length === 0) {
      setFetchError("先获取模型，再开始批量检测。");
      return;
    }

    if (visibleModels.length === 0) {
      setFetchError("至少选择一个要检测的模型。");
      return;
    }

    const tasks = buildRoundRobinTasks(probeEntries, visibleModels);

    if (tasks.length === 0) {
      setFetchError(`当前选中的模型没有匹配到可探测的 ${activeColumnLabel}。`);
      setFieldErrors({});
      setProbeResults({});
      return;
    }

    const runId = checkRunId.current + 1;
    checkRunId.current = runId;

    setCheckingModels(true);
    setFetchError("");
    setFieldErrors({});
    setProbeResults(
      Object.fromEntries(
        tasks.map((task) => [
          getProbeResultKey(task.columnId, task.modelId),
          {
            columnId: task.columnId,
            modelId: task.modelId,
            status: "idle",
            firstTokenLatencyMs: null,
            errorMessage: null
          }
        ])
      )
    );

    try {
      const queue = [...tasks];
      const workerCount = Math.min(parseConcurrency(form.concurrency) ?? 1, queue.length);

      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (queue.length > 0) {
            const task = queue.shift();

            if (!task || checkRunId.current !== runId) {
              return;
            }

            updateProbeResult(task.columnId, task.modelId, {
              status: "checking",
              firstTokenLatencyMs: null,
              errorMessage: null
            });

            try {
              const result = await checkOneModel(task.baseUrl, task.apiKey, task.modelId);

              if (checkRunId.current !== runId) {
                return;
              }

              updateProbeResult(task.columnId, task.modelId, {
                status: "available",
                firstTokenLatencyMs: result.firstTokenLatencyMs,
                errorMessage: null
              });
            } catch (error) {
              if (checkRunId.current !== runId) {
                return;
              }

              updateProbeResult(task.columnId, task.modelId, {
                status: "unavailable",
                firstTokenLatencyMs: null,
                errorMessage: getErrorMessage(error)
              });
            }
          }
        })
      );
    } finally {
      if (checkRunId.current === runId) {
        setCheckingModels(false);
      }
    }
  };

  const toggleModelSelection = (modelId: string) => {
    setSelectedModelIds((current) =>
      current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId]
    );
  };

  const heroTitle = isMultiBaseUrlMode ? "多端点 API 探测" : "多 Key API 探测";
  const heroSubtitle = isMultiBaseUrlMode
    ? "单密钥多端点、模型并集、按列盘点，直接看同一枚 Key 在不同 Base URL 下的可用性和首字延迟。"
    : "同端点多密钥、模型并集、按列盘点，直接看每个 Key 对每个模型的可用性和首字延迟。";
  const configDescription = isMultiBaseUrlMode
    ? "同一枚 API Key 下，每行输入一个 Base URL。"
    : "同一个 Base URL 下，每行输入一枚 API Key。";
  const columnCount = probeEntries.length || pendingColumnCount;
  const columnStatusLabel = isMultiBaseUrlMode ? "Base URL 拉取状态" : "API Key 拉取状态";
  const emptyColumnLabel = isMultiBaseUrlMode ? "待拉取 Endpoint" : "待拉取 Key";
  const resultsColumnLabel = isMultiBaseUrlMode ? "Base URL" : "API Key";
  const columnDetailsTitle = isMultiBaseUrlMode ? "Endpoint 拉取详情" : "Key 拉取详情";
  const columnDetailsId = "column-fetch-details";
  const modelPickerDescription = isMultiBaseUrlMode
    ? "模型列表来自所有成功拉取的 Base URL 的并集。"
    : "模型列表来自所有成功拉取的 Key 的并集。";

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>

      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">check-your-api</p>
          <h1>{heroTitle}</h1>
          <p className="subtitle">{heroSubtitle}</p>
        </div>

        <aside className="hero-status" aria-live="polite">
          <span className="summary-label">当前状态</span>
          <strong>{statusHeadline}</strong>
          <p>{statusDescription}</p>
          <div className="hero-meta">
            <span>
              {activeColumnLabel} {columnCount}
            </span>
            <span>模型 {visibleModels.length}</span>
            <span>任务 {totalTaskCount}</span>
          </div>
        </aside>
      </header>

      <main className="content" id="main-content">
        <section className="panel panel-grid">
          <div className="config-column">
            <div className="section-head section-head-tight">
              <div>
                <h2>连接配置</h2>
                <p>{configDescription}</p>
              </div>
            </div>

            <form className="form" onSubmit={handleSubmit} noValidate>
              <div className="mode-switch" role="tablist" aria-label="检测模式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isMultiBaseUrlMode}
                  className={`mode-tab${!isMultiBaseUrlMode ? " is-active" : ""}`}
                  disabled={fetchingModels || checkingModels}
                  onClick={() => updateMode("multiKey")}
                >
                  多 Key
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isMultiBaseUrlMode}
                  className={`mode-tab${isMultiBaseUrlMode ? " is-active" : ""}`}
                  disabled={fetchingModels || checkingModels}
                  onClick={() => updateMode("multiBaseUrl")}
                >
                  多 Base URL
                </button>
              </div>

              {isMultiBaseUrlMode ? (
                <>
                  <label className="field" htmlFor="api-key">
                    <span>API Key</span>
                    <input
                      ref={(node) => {
                        fieldRefs.current.apiKey = node;
                      }}
                      id="api-key"
                      name="apiKey"
                      type="text"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={fetchingModels || checkingModels}
                      aria-invalid={Boolean(fieldErrors.apiKey)}
                      aria-describedby="api-key-help api-key-error"
                      placeholder="sk-..."
                      value={apiKeyInput}
                      onChange={(event) => updateApiKeyField(event.target.value)}
                    />
                    <small className="field-help" id="api-key-help">
                      密钥只保存在当前页面状态，刷新后会清空。
                    </small>
                    {fieldErrors.apiKey ? (
                      <small className="field-error" id="api-key-error" role="alert">
                        {fieldErrors.apiKey}
                      </small>
                    ) : null}
                  </label>

                  <label className="field" htmlFor="base-urls">
                    <span>API Base URLs</span>
                    <textarea
                      ref={(node) => {
                        fieldRefs.current.baseUrls = node;
                      }}
                      id="base-urls"
                      name="baseUrls"
                      rows={6}
                      inputMode="url"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={fetchingModels || checkingModels}
                      aria-invalid={Boolean(fieldErrors.baseUrls)}
                      aria-describedby="base-urls-help base-urls-error"
                      placeholder={"https://api.openai.com/v1\nhttps://example.com/v1"}
                      value={form.baseUrls}
                      onChange={(event) => updateFormField("baseUrls", event.target.value)}
                    />
                    <small className="field-help" id="base-urls-help">
                      已识别 {parsedBaseUrls.baseUrls.length} 个 URL
                      {parsedBaseUrls.duplicateCount > 0
                        ? `，已忽略 ${parsedBaseUrls.duplicateCount} 个重复项`
                        : ""}
                      {parsedBaseUrls.invalidCount > 0
                        ? `，有 ${parsedBaseUrls.invalidCount} 个格式错误`
                        : ""}
                      。通常以 `/v1` 结尾。
                    </small>
                    {fieldErrors.baseUrls ? (
                      <small className="field-error" id="base-urls-error" role="alert">
                        {fieldErrors.baseUrls}
                      </small>
                    ) : null}
                  </label>
                </>
              ) : (
                <>
                  <label className="field" htmlFor="base-url">
                    <span>API Base URL</span>
                    <input
                      ref={(node) => {
                        fieldRefs.current.baseUrl = node;
                      }}
                      id="base-url"
                      name="baseUrl"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={fetchingModels || checkingModels}
                      aria-invalid={Boolean(fieldErrors.baseUrl)}
                      aria-describedby="base-url-help base-url-error"
                      placeholder="https://example.com/v1"
                      value={form.baseUrl}
                      onChange={(event) => updateFormField("baseUrl", event.target.value)}
                    />
                    <small className="field-help" id="base-url-help">
                      OpenAI 兼容地址，通常以 `/v1` 结尾。
                    </small>
                    {fieldErrors.baseUrl ? (
                      <small className="field-error" id="base-url-error" role="alert">
                        {fieldErrors.baseUrl}
                      </small>
                    ) : null}
                  </label>

                  <label className="field" htmlFor="api-keys">
                    <span>API Keys</span>
                    <textarea
                      ref={(node) => {
                        fieldRefs.current.apiKeys = node;
                      }}
                      id="api-keys"
                      name="apiKeys"
                      rows={6}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={fetchingModels || checkingModels}
                      aria-invalid={Boolean(fieldErrors.apiKeys)}
                      aria-describedby="api-keys-help api-keys-error"
                      placeholder={"sk-...\nsk-..."}
                      value={apiKeysInput}
                      onChange={(event) => updateApiKeysField(event.target.value)}
                    />
                    <small className="field-help" id="api-keys-help">
                      已识别 {parsedApiKeys.length} 枚 Key
                      {duplicateKeyCount > 0 ? `，已忽略 ${duplicateKeyCount} 个重复项` : ""}。
                      密钥只保存在当前页面状态，刷新后会清空。
                    </small>
                    {fieldErrors.apiKeys ? (
                      <small className="field-error" id="api-keys-error" role="alert">
                        {fieldErrors.apiKeys}
                      </small>
                    ) : null}
                  </label>
                </>
              )}

              <div className="control-row">
                <label className="field field-compact" htmlFor="concurrency">
                  <span>总并发数</span>
                  <input
                    ref={(node) => {
                      fieldRefs.current.concurrency = node;
                    }}
                    id="concurrency"
                    name="concurrency"
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    autoComplete="off"
                    disabled={fetchingModels || checkingModels}
                    aria-invalid={Boolean(fieldErrors.concurrency)}
                    aria-describedby="concurrency-help concurrency-error"
                    placeholder="5"
                    value={form.concurrency}
                    onChange={(event) =>
                      updateFormField("concurrency", event.target.value.replace(/[^\d]/g, ""))
                    }
                  />
                  <small className="field-help" id="concurrency-help">
                    作用于模型拉取和批量检测的总队列。
                  </small>
                  {fieldErrors.concurrency ? (
                    <small className="field-error" id="concurrency-error" role="alert">
                      {fieldErrors.concurrency}
                    </small>
                  ) : null}
                </label>

                <label className="field prompt-field" htmlFor="prompt">
                  <span>请求内容</span>
                  <textarea
                    ref={(node) => {
                      fieldRefs.current.prompt = node;
                    }}
                    id="prompt"
                    name="prompt"
                    rows={4}
                    autoComplete="off"
                    disabled={fetchingModels || checkingModels}
                    aria-invalid={Boolean(fieldErrors.prompt)}
                    aria-describedby="prompt-help prompt-error"
                    placeholder="Hi"
                    value={form.prompt}
                    onChange={(event) => updateFormField("prompt", event.target.value)}
                  />
                  <small className="field-help" id="prompt-help">
                    所有模型使用同一段 prompt，便于比较延迟。
                  </small>
                  {fieldErrors.prompt ? (
                    <small className="field-error" id="prompt-error" role="alert">
                      {fieldErrors.prompt}
                    </small>
                  ) : null}
                </label>
              </div>

              <div className="actions">
                <button type="submit" disabled={fetchingModels || checkingModels}>
                  {fetchingModels ? "获取中..." : "获取模型并集"}
                </button>

                <button
                  type="button"
                  className="secondary"
                  onClick={() => setShowModelPicker(true)}
                  disabled={fetchingModels || checkingModels || models.length === 0}
                >
                  选择模型 ({selectedModelIds.length}/{models.length})
                </button>

                <button
                  type="button"
                  className="dark"
                  onClick={() => void batchCheckModels()}
                  disabled={fetchingModels || checkingModels || visibleModels.length === 0}
                >
                  {checkingModels ? "检测中..." : "批量检测"}
                </button>
              </div>
            </form>
          </div>

          <aside className="summary-column" aria-live="polite">
            <dl className="stats-strip" aria-label="检测统计">
              <div className="stat-pill">
                <dt>{activeColumnLabel}</dt>
                <dd>{columnCount}</dd>
              </div>
              <div className="stat-pill">
                <dt>模型</dt>
                <dd>{visibleModels.length}</dd>
              </div>
              <div className="stat-pill">
                <dt>任务</dt>
                <dd>{totalTaskCount}</dd>
              </div>
            </dl>

            {probeEntries.length === 0 ? (
              <div className="key-empty">
                <strong>{pendingColumnCount}</strong>
                <span>{emptyColumnLabel}</span>
              </div>
            ) : (
              <section className="column-details">
                <div className="column-details-head">
                  <div className="column-details-title">
                    <strong>{columnDetailsTitle}</strong>
                    <span>
                      已处理 {loadedEntryCount + failedEntryCount}/{probeEntries.length}
                      {failedEntryCount > 0 ? `，失败 ${failedEntryCount}` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary details-toggle"
                    aria-expanded={showColumnDetails}
                    aria-controls={columnDetailsId}
                    onClick={() => setShowColumnDetails((current) => !current)}
                  >
                    {showColumnDetails ? "收起" : "展开"} {probeEntries.length} 项
                  </button>
                </div>

                {showColumnDetails ? (
                  <div className="key-list" id={columnDetailsId} aria-label={columnStatusLabel}>
                    {probeEntries.map((entry) => (
                      <article className="key-card" key={entry.id}>
                        <div>
                          <strong>{entry.displayLabel}</strong>
                          <span>{entry.modelIds.length} 个模型</span>
                        </div>
                        <span className={`fetch-badge fetch-${entry.modelFetchStatus}`}>
                          {getFetchStatusLabel(entry.modelFetchStatus)}
                        </span>
                        {entry.modelFetchError ? (
                          <p className="key-error">{entry.modelFetchError}</p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : null}
              </section>
            )}
          </aside>
        </section>

        {fetchError ? (
          <section className="notice error" role="alert" aria-live="assertive">
            {fetchError}
          </section>
        ) : null}

        {scaleWarning ? (
          <section className="notice warning" role="status">
            {scaleWarning}
          </section>
        ) : null}

        <section className="panel results-panel" aria-busy={checkingModels}>
          <div className="section-head results-head">
            <div>
              <h2>按列盘点</h2>
              <p>按 {resultsColumnLabel} 分组显示已列出的模型、状态、延迟和失败原因。</p>
            </div>

            <div className="filter-group" role="tablist" aria-label="结果过滤">
              {(
                [
                  ["all", "全部"],
                  ["available", "可用"],
                  ["unavailable", "不可用"],
                  ["pending", "待完成"]
                ] as const satisfies ReadonlyArray<readonly [ResultFilter, string]>
              ).map(([filter, label]) => (
                <button
                  key={filter}
                  type="button"
                  role="tab"
                  aria-selected={resultFilter === filter}
                  className={`filter-chip${resultFilter === filter ? " is-active" : ""}`}
                  onClick={() => setResultFilter(filter)}
                >
                  {label}
                  <span>{filterCounts[filter]}</span>
                </button>
              ))}
            </div>
          </div>

          {totalTaskCount > 0 ? (
            <div className="progress-card" aria-live="polite">
              <div className="progress-copy">
                <strong>{checkingModels ? "检测进行中" : "检测概览"}</strong>
                <span>
                  已完成 {checkedCount} / {totalTaskCount}，待完成 {pendingCount}，可用{" "}
                  {availableCount}，不可用 {unavailableCount}，进行中 {checkingCount}
                </span>
              </div>
              <div
                className="progress-track"
                aria-hidden="true"
                style={{ "--progress": `${Math.round(progressValue * 100)}%` } as CSSProperties}
              />
            </div>
          ) : null}

          {models.length === 0 ? (
            <div className="empty empty-dark">还没有模型。先获取模型并集。</div>
          ) : visibleModels.length === 0 ? (
            <div className="empty empty-dark">当前没有选中任何模型。</div>
          ) : (
            <div className="probe-groups" aria-label="按列盘点结果">
              {displayedProbeGroups.map((group) => (
                <section className="probe-group" key={group.entry.id}>
                  <div className="probe-group-head">
                    <div>
                      <h3>{group.entry.displayLabel}</h3>
                      <p>
                        {group.totalCount} 个模型，已完成 {group.checkedCount}，待完成{" "}
                        {group.pendingCount}
                      </p>
                    </div>

                    <dl className="probe-group-stats" aria-label={`${group.entry.label} 统计`}>
                      <div>
                        <dt>可用</dt>
                        <dd>{group.availableCount}</dd>
                      </div>
                      <div>
                        <dt>不可用</dt>
                        <dd>{group.unavailableCount}</dd>
                      </div>
                    </dl>
                  </div>

                  {group.totalCount === 0 ? (
                    <div className="probe-empty">当前选择下没有可探测模型。</div>
                  ) : group.items.length === 0 ? (
                    <div className="probe-empty">这个筛选条件下没有结果。</div>
                  ) : (
                    <div className="probe-list">
                      {group.items.map(({ model, result, status, latencyLevel }) => (
                        <article className="probe-card" key={model.id}>
                          <div className="probe-card-main">
                            <strong translate="no">{model.id}</strong>
                            <span>
                              {model.owned_by ? `owned by ${model.owned_by}` : "未提供所有者信息"}
                            </span>
                          </div>

                          <div className="probe-card-status">
                            <span className={`badge badge-${status}`}>
                              {getStatusLabel(status)}
                            </span>
                            {status === "available" ? (
                              <span className={`latency latency-${latencyLevel}`}>
                                {typeof result?.firstTokenLatencyMs === "number"
                                  ? `${result.firstTokenLatencyMs} ms`
                                  : "无首字延迟"}
                              </span>
                            ) : null}
                          </div>

                          {status === "unavailable" && result?.errorMessage ? (
                            <p className="failure-reason">{result.errorMessage}</p>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}
        </section>
      </main>

      {showModelPicker ? (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setShowModelPicker(false);
            }
          }}
        >
          <section
            className="modal panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-picker-title"
            aria-describedby="model-picker-description"
          >
            <div className="section-head modal-head">
              <div>
                <h2 id="model-picker-title">选择模型</h2>
                <p id="model-picker-description">{modelPickerDescription}</p>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => setShowModelPicker(false)}
              >
                完成
              </button>
            </div>

            <div className="picker-toolbar">
              <span>
                已选 {selectedModelIds.length} / {models.length}
              </span>
              <div className="picker-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setSelectedModelIds([])}
                >
                  取消全选
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setSelectedModelIds(models.map((model) => model.id))}
                >
                  全选
                </button>
              </div>
            </div>

            <label className="field picker-search" htmlFor="model-search">
              <span>搜索模型</span>
              <input
                id="model-search"
                name="modelSearch"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="输入模型名或 owned by"
                value={modelSearchQuery}
                onChange={(event) => setModelSearchQuery(event.target.value)}
              />
            </label>

            <div className="picker-list">
              {filteredPickerModels.length === 0 ? (
                <div className="empty">没有匹配到模型。</div>
              ) : (
                filteredPickerModels.map((model) => {
                  const selected = selectedModelIdSet.has(model.id);

                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={`picker-item${selected ? " is-selected" : ""}`}
                      onClick={() => toggleModelSelection(model.id)}
                    >
                      <span className="picker-check" aria-hidden="true">
                        {selected ? "✓" : ""}
                      </span>
                      <span className="picker-copy">
                        <strong translate="no">{model.id}</strong>
                        <small>
                          {model.owned_by ? `owned by ${model.owned_by}` : "未提供所有者信息"}
                        </small>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
