// 接口出错的统一表示：把后端的 { error: { code, message, details } } 和各种意外情况
// （反向代理的 502 页面、断网、返回了非 JSON）都归一成 ApiError，界面只管显示 message。

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /**
   * 会话没了（没登录 / 过期 / 账号被停用）。只认 unauthorized 这个 code：
   * 二次验证码填错（totp_invalid）、访问密钥填错（invalid_key）同样是 401，但那不是掉线，不能把人踢回登录页。
   */
  get isSessionLost(): boolean {
    return this.status === 401 && this.code === "unauthorized";
  }

  /** 422 invalid_settings 的 details.fields：{ 设置项: 原因 }。其它错误返回空对象。 */
  get fieldErrors(): Record<string, string> {
    const details = this.details;
    if (!isRecord(details) || !isRecord(details.fields)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(details.fields)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 没拿到后端的 JSON 错误体时，按状态码给一句人话。 */
function fallbackMessage(status: number): string {
  if (status === 401) return "请先登录";
  if (status === 403) return "没有权限做这个操作";
  if (status === 404) return "没有找到这个资源";
  if (status === 413) return "提交的内容太大了";
  if (status === 429) return "操作太频繁了，稍后再试";
  if (status >= 500) return `服务器出错了（HTTP ${status}），稍后再试`;
  return `请求失败（HTTP ${status}）`;
}

/** 把一个非 2xx 响应的正文解析成 ApiError。 */
export function parseErrorBody(status: number, text: string): ApiError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  if (error && typeof error.message === "string" && error.message) {
    const code = typeof error.code === "string" && error.code ? error.code : `http_${status}`;
    return new ApiError(status, code, error.message, error.details);
  }
  return new ApiError(status, `http_${status}`, fallbackMessage(status));
}

/** fetch 本身失败（断网 / 服务没起 / 被拦截）。 */
export function networkError(): ApiError {
  return new ApiError(0, "network", "连不上服务器，请检查网络后重试");
}

/** 任何异常 → 给人看的一句话（toast / 表单错误都用它）。 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "出了点意外，请重试";
}
