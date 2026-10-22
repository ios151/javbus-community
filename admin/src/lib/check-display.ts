// 条目检查结果怎么显示：把「没查过」「没查成」「正常（带说明）」这几种容易混的情况分开。
//
// - 没查过：checkStatus = unchecked，没有说明（从没检查过，或改了地址清掉了结果）；
// - 没查成：checkStatus = unchecked，但带 checkDetail（检查过了，可是一项都没法判断——比如只剩被年龄验证页挡住的链接），
//           它不是「正常」（不会清零失效计数、不会触发自动恢复），也不是问题，说明里写了原因；
// - 正常：ok；带说明的正常（比如「链接 站点先跳到年龄验证页…」）只是告知原因，不当成问题；
// - 存疑 / 失效：warn / dead，说明是具体的原因，是问题。

import { CHECK_STATUS_NAMES, type ItemDTO } from "../../../shared/types";

type Checkable = Pick<ItemDTO, "checkStatus" | "checkDetail">;

/** 检查过但一项都没法判断（unchecked + 带说明）。 */
export function isUnverifiable(item: Checkable): boolean {
  return item.checkStatus === "unchecked" && item.checkDetail.trim() !== "";
}

/** 徽章上写什么字。 */
export function checkName(item: Checkable): string {
  return isUnverifiable(item) ? "没查成" : CHECK_STATUS_NAMES[item.checkStatus];
}

/** 说明只是告知原因、不是问题（正常 + 说明、没查成 + 说明）：用中性的灰色小字显示，不带警示色。 */
export function isCheckNote(item: Checkable): boolean {
  if (item.checkDetail.trim() === "") return false;
  return item.checkStatus === "ok" || item.checkStatus === "unchecked";
}
