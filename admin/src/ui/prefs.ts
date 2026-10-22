// 本机偏好：「遮挡封面」开关（默认开，存 localStorage）。
// 这个后台的内容是成人向的，常常在公共场合打开，所以默认把封面糊掉，鼠标悬停 / 点一下才看得清。

import { browserStorage, readBool, writeBool } from "../lib/storage";
import { createStore } from "./store";

const MASK_KEY = "jc-admin:mask-covers";
const storage = browserStorage();

export const prefsStore = createStore({ maskCovers: readBool(storage, MASK_KEY, true) });

export function setMaskCovers(on: boolean): void {
  writeBool(storage, MASK_KEY, on);
  prefsStore.set((s) => ({ ...s, maskCovers: on }));
}
