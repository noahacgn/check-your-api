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
type ResultFilter = "all" | "available" | "unavailable" | "pending";
type FieldName = "baseUrl" | "apiKeys" | "concurrency" | "prompt";
type FieldErrors = Partial<Record<FieldName, string>>;
type InputElement = HTMLInputElement | HTMLTextAreaElement;

type ApiKeyEntry = {
  id: string;
  value: string;
  label: string;
  maskedLabel: string;
  modelFetchStatus: ModelFetchStatus;
  modelFetchError: string | null;
  modelIds: string[];
};

type MatrixResult = {
  keyId: string;
  modelId: string;
  status: CheckStatus;
  firstTokenLatencyMs: number | null;
  errorMessage: string | null;
};

type MatrixTask = {
  keyId: string;
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
const fieldOrder: FieldName[] = ["baseUrl", "apiKeys", "concurrency", "prompt"];

const defaultForm = {
  baseUrl: "",
  concurrency: "5",
  prompt: "Hi"
};

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
      baseUrl: parsed.baseUrl ?? "",
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

function maskApiKey(apiKey: string) {
  if (apiKey.length <= 6) {
    return "******";
  }

  const prefix = apiKey.startsWith("sk-") ? "sk-" : apiKey.slice(0, 4);
  return `${prefix}...${apiKey.slice(-4)}`;
}

function createApiKeyEntries(apiKeys: string[]): ApiKeyEntry[] {
  return apiKeys.map((apiKey, index) => {
    const label = `Key ${index + 1}`;

    return {
      id: `key-${index + 1}`,
      value: apiKey,
      label,
      maskedLabel: `${label} · ${maskApiKey(apiKey)}`,
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

function getMatrixResultKey(keyId: string, modelId: string) {
  return `${keyId}::${modelId}`;
}

function getRawApiKeyLineCount(value: string) {
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
  const [apiKeysInput, setApiKeysInput] = useState("");
  const [apiKeyEntries, setApiKeyEntries] = useState<ApiKeyEntry[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [checkingModels, setCheckingModels] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [matrixResults, setMatrixResults] = useState<Record<string, MatrixResult>>({});
  const fieldRefs = useRef<Record<FieldName, InputElement | null>>({
    baseUrl: null,
    apiKeys: null,
    concurrency: null,
    prompt: null
  });
  const modelFetchRunId = useRef(0);
  const checkRunId = useRef(0);

  const resolvedBaseUrl = useMemo(() => normalizeBaseUrl(form.baseUrl), [form.baseUrl]);
  const parsedApiKeys = useMemo(() => parseApiKeys(apiKeysInput), [apiKeysInput]);
  const duplicateKeyCount = useMemo(
    () => Math.max(0, getRawApiKeyLineCount(apiKeysInput) - parsedApiKeys.length),
    [apiKeysInput, parsedApiKeys.length]
  );
  const selectedModelIdSet = useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  const visibleModels = useMemo(
    () => models.filter((model) => selectedModelIdSet.has(model.id)),
    [models, selectedModelIdSet]
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

  const totalTaskCount = apiKeyEntries.length * visibleModels.length;
  const visibleResultValues = useMemo(
    () =>
      apiKeyEntries
        .flatMap((entry) =>
          visibleModels.map((model) => matrixResults[getMatrixResultKey(entry.id, model.id)])
        )
        .filter((result): result is MatrixResult => Boolean(result)),
    [apiKeyEntries, matrixResults, visibleModels]
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
  const loadedKeyCount = apiKeyEntries.filter(
    (entry) => entry.modelFetchStatus === "loaded"
  ).length;
  const failedKeyCount = apiKeyEntries.filter(
    (entry) => entry.modelFetchStatus === "failed"
  ).length;
  const scaleWarning =
    totalTaskCount > LARGE_TASK_WARNING_THRESHOLD
      ? `本次会产生 ${totalTaskCount} 个探测任务。免费 Vercel 建议先降低模型数或并发数。`
      : "";

  const getResultForCell = (keyId: string, modelId: string) =>
    matrixResults[getMatrixResultKey(keyId, modelId)];

  const getModelStatuses = (modelId: string) =>
    apiKeyEntries.map((entry) => getResultForCell(entry.id, modelId)?.status ?? "idle");

  const filterCounts: Record<ResultFilter, number> = {
    all: visibleModels.length,
    available: visibleModels.filter((model) =>
      getModelStatuses(model.id).some((status) => status === "available")
    ).length,
    unavailable: visibleModels.filter((model) =>
      getModelStatuses(model.id).some((status) => status === "unavailable")
    ).length,
    pending: visibleModels.filter((model) =>
      getModelStatuses(model.id).some((status) => status === "idle" || status === "checking")
    ).length
  };

  const displayedModels = useMemo(() => {
    if (resultFilter === "all") {
      return visibleModels;
    }

    if (resultFilter === "pending") {
      return visibleModels.filter((model) =>
        getModelStatuses(model.id).some(
          (status) => status === "idle" || status === "checking"
        )
      );
    }

    return visibleModels.filter((model) =>
      getModelStatuses(model.id).some((status) => status === resultFilter)
    );
  }, [matrixResults, resultFilter, visibleModels, apiKeyEntries]);

  const statusHeadline = useMemo(() => {
    if (checkingModels) {
      return `正在检测 ${checkedCount}/${totalTaskCount}`;
    }

    if (fetchingModels) {
      return `正在拉取 ${loadedKeyCount + failedKeyCount}/${apiKeyEntries.length}`;
    }

    if (models.length > 0) {
      return `已合并 ${models.length} 个模型`;
    }

    return "等待连接 API";
  }, [
    apiKeyEntries.length,
    checkedCount,
    checkingModels,
    failedKeyCount,
    fetchingModels,
    loadedKeyCount,
    models.length,
    totalTaskCount
  ]);

  const statusDescription = useMemo(() => {
    if (resolvedBaseUrl) {
      return `Endpoint：${resolvedBaseUrl}`;
    }

    return "填写同一个 Base URL 下的多枚 API Key。";
  }, [resolvedBaseUrl]);

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
    setApiKeyEntries([]);
    setModels([]);
    setSelectedModelIds([]);
    setMatrixResults({});
    setShowModelPicker(false);
    setModelSearchQuery("");
    setResultFilter("all");
  };

  const updateFormField = (field: keyof typeof defaultForm, value: string) => {
    persistForm({
      ...form,
      [field]: value
    });
    clearFieldError(field);
    setFetchError("");

    if (field === "baseUrl") {
      resetFetchedData();
    }
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

    if (!resolvedBaseUrl) {
      nextErrors.baseUrl = "Base URL 不能为空。";
    } else if (!isValidUrl(resolvedBaseUrl)) {
      nextErrors.baseUrl = "Base URL 格式不对，示例：https://example.com/v1";
    }

    if (parsedApiKeys.length === 0) {
      nextErrors.apiKeys = "至少输入一枚 API Key，每行一枚。";
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

  const updateMatrixResult = (
    keyId: string,
    modelId: string,
    patch: Partial<MatrixResult> & Pick<MatrixResult, "status">
  ) => {
    setMatrixResults((current) => {
      const resultKey = getMatrixResultKey(keyId, modelId);

      return {
        ...current,
        [resultKey]: {
          ...current[resultKey],
          keyId,
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
    const nextKeyEntries = createApiKeyEntries(parsedApiKeys).map((entry) => ({
      ...entry,
      modelFetchStatus: "loading" as const
    }));
    const modelsById = new Map<string, Model>();
    let successfulKeyCount = 0;
    let failedFetchCount = 0;

    setFetchingModels(true);
    setFetchError("");
    setFieldErrors({});
    setApiKeyEntries(nextKeyEntries);
    setModels([]);
    setSelectedModelIds([]);
    setMatrixResults({});
    setResultFilter("all");

    try {
      const queue = [...nextKeyEntries];
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
                baseUrl: resolvedBaseUrl,
                apiKey: entry.value
              });
              const nextModels =
                isModelsResponse(payload) && Array.isArray(payload.data)
                  ? payload.data.filter(
                      (item: Model): item is Model => typeof item?.id === "string"
                    )
                  : [];

              successfulKeyCount += 1;

              for (const model of nextModels) {
                if (!modelsById.has(model.id)) {
                  modelsById.set(model.id, model);
                }
              }

              if (modelFetchRunId.current !== runId) {
                return;
              }

              setApiKeyEntries((current) =>
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

              setApiKeyEntries((current) =>
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
      setModelSearchQuery("");

      if (successfulKeyCount === 0) {
        setFetchError("所有 API Key 都没能拉取模型。请检查 Base URL 或密钥权限。");
      } else if (mergedModels.length === 0) {
        setFetchError("接口返回成功，但没拿到任何模型。");
      } else if (failedFetchCount > 0) {
        setFetchError("部分 API Key 拉取模型失败，仍可继续检测已合并的模型。");
      }
    } finally {
      if (modelFetchRunId.current === runId) {
        setFetchingModels(false);
      }
    }
  };

  const checkOneModel = async (apiKey: string, modelId: string) =>
    requestProxy<CheckResponse>("/api/check", {
      baseUrl: resolvedBaseUrl,
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

    if (apiKeyEntries.length === 0 || models.length === 0) {
      setFetchError("先获取模型，再开始矩阵检测。");
      return;
    }

    if (visibleModels.length === 0) {
      setFetchError("至少选择一个要检测的模型。");
      return;
    }

    const runId = checkRunId.current + 1;
    checkRunId.current = runId;
    const tasks: MatrixTask[] = apiKeyEntries.flatMap((entry) =>
      visibleModels.map((model) => ({
        keyId: entry.id,
        apiKey: entry.value,
        modelId: model.id
      }))
    );

    setCheckingModels(true);
    setFetchError("");
    setFieldErrors({});
    setMatrixResults(
      Object.fromEntries(
        tasks.map((task) => [
          getMatrixResultKey(task.keyId, task.modelId),
          {
            keyId: task.keyId,
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

            updateMatrixResult(task.keyId, task.modelId, {
              status: "checking",
              firstTokenLatencyMs: null,
              errorMessage: null
            });

            try {
              const result = await checkOneModel(task.apiKey, task.modelId);

              if (checkRunId.current !== runId) {
                return;
              }

              updateMatrixResult(task.keyId, task.modelId, {
                status: "available",
                firstTokenLatencyMs: result.firstTokenLatencyMs,
                errorMessage: null
              });
            } catch (error) {
              if (checkRunId.current !== runId) {
                return;
              }

              updateMatrixResult(task.keyId, task.modelId, {
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

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>

      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">check-your-api</p>
          <h1>多 Key API 探测</h1>
          <p className="subtitle">
            同端点多密钥、模型并集、矩阵检测，直接看每个 Key 对每个模型的可用性和首字延迟。
          </p>
        </div>

        <aside className="hero-status" aria-live="polite">
          <span className="summary-label">当前状态</span>
          <strong>{statusHeadline}</strong>
          <p>{statusDescription}</p>
          <div className="hero-meta">
            <span>Key {apiKeyEntries.length || parsedApiKeys.length}</span>
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
                <p>同一个 Base URL 下，每行输入一枚 API Key。</p>
              </div>
            </div>

            <form className="form" onSubmit={handleSubmit} noValidate>
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
                    作用于模型拉取和矩阵检测的总队列。
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
                <dt>Key</dt>
                <dd>{apiKeyEntries.length || parsedApiKeys.length}</dd>
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

            <div className="key-list" aria-label="API Key 拉取状态">
              {apiKeyEntries.length === 0 ? (
                <div className="key-empty">
                  <strong>{parsedApiKeys.length || 0}</strong>
                  <span>待拉取 Key</span>
                </div>
              ) : (
                apiKeyEntries.map((entry) => (
                  <article className="key-card" key={entry.id}>
                    <div>
                      <strong>{entry.maskedLabel}</strong>
                      <span>{entry.modelIds.length} 个模型</span>
                    </div>
                    <span className={`fetch-badge fetch-${entry.modelFetchStatus}`}>
                      {getFetchStatusLabel(entry.modelFetchStatus)}
                    </span>
                    {entry.modelFetchError ? (
                      <p className="key-error">{entry.modelFetchError}</p>
                    ) : null}
                  </article>
                ))
              )}
            </div>
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
              <h2>探测矩阵</h2>
              <p>行是模型，列是 API Key；每个单元格独立展示状态、延迟和失败原因。</p>
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
          ) : displayedModels.length === 0 ? (
            <div className="empty empty-dark">这个筛选条件下没有结果。</div>
          ) : (
            <>
              <div className="matrix-scroll">
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th scope="col">模型</th>
                      {apiKeyEntries.map((entry) => (
                        <th key={entry.id} scope="col">
                          {entry.maskedLabel}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedModels.map((model) => (
                      <tr key={model.id}>
                        <th scope="row">
                          <span translate="no">{model.id}</span>
                          <small>
                            {model.owned_by ? `owned by ${model.owned_by}` : "未提供所有者信息"}
                          </small>
                        </th>
                        {apiKeyEntries.map((entry) => {
                          const result = getResultForCell(entry.id, model.id);
                          const status = result?.status ?? "idle";
                          const latencyLevel = getLatencyLevel(result?.firstTokenLatencyMs ?? null);
                          const listedByKey = entry.modelIds.includes(model.id);

                          return (
                            <td key={entry.id}>
                              <div className="matrix-cell">
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
                                {status === "unavailable" && result?.errorMessage ? (
                                  <span className="failure-reason">{result.errorMessage}</span>
                                ) : null}
                                {!listedByKey ? (
                                  <span className="not-listed">未列入 /models</span>
                                ) : null}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mobile-results" aria-label="移动端矩阵结果">
                {apiKeyEntries.map((entry) => (
                  <section className="mobile-key-group" key={entry.id}>
                    <h3>{entry.maskedLabel}</h3>
                    <div className="mobile-model-list">
                      {displayedModels.map((model) => {
                        const result = getResultForCell(entry.id, model.id);
                        const status = result?.status ?? "idle";
                        const latencyLevel = getLatencyLevel(result?.firstTokenLatencyMs ?? null);
                        const listedByKey = entry.modelIds.includes(model.id);

                        return (
                          <article className="mobile-model-card" key={model.id}>
                            <div>
                              <strong translate="no">{model.id}</strong>
                              <small>
                                {listedByKey ? "已列入 /models" : "未列入 /models"}
                              </small>
                            </div>
                            <span className={`badge badge-${status}`}>
                              {getStatusLabel(status)}
                            </span>
                            {status === "available" ? (
                              <p className={`latency latency-${latencyLevel}`}>
                                首字延迟{" "}
                                {typeof result?.firstTokenLatencyMs === "number"
                                  ? `${result.firstTokenLatencyMs} ms`
                                  : "未获取到"}
                              </p>
                            ) : null}
                            {status === "unavailable" && result?.errorMessage ? (
                              <p className="failure-reason">{result.errorMessage}</p>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </>
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
                <p id="model-picker-description">模型列表来自所有成功拉取的 Key 的并集。</p>
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
