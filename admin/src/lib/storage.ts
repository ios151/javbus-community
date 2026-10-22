// 记在浏览器本地的小偏好（比如「遮挡封面」开关）。localStorage 在隐私模式 / 被禁用时会抛错，所有读写都兜住。

/** 只用到 getItem / setItem，测试里可以塞个假的。 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readBool(storage: KeyValueStorage | undefined, key: string, fallback: boolean): boolean {
  try {
    const value = storage?.getItem(key);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {
    // 读不了就用默认值
  }
  return fallback;
}

export function writeBool(storage: KeyValueStorage | undefined, key: string, value: boolean): void {
  try {
    storage?.setItem(key, value ? "1" : "0");
  } catch {
    // 写不进去就算了：这次会话里照样生效，只是下次打开恢复默认
  }
}

/** 浏览器里的 localStorage；访问它本身也可能抛错（被禁用 cookie 时），所以包一层。 */
export function browserStorage(): KeyValueStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
