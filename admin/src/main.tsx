// 入口：注册「登录态丢了怎么办」、兜底未处理的异常，然后把 <App /> 挂到页面上。

import { render } from "preact";

import { setSessionLostHandler } from "./api";
import { App } from "./app";
import { errorMessage } from "./lib/errors";
import "./styles.css";
import { sessionLost, sessionStore } from "./ui/session";
import { toast } from "./ui/toast";

// 会话过期 / 账号被停用 / 被踢下线：清掉登录态，界面自动回到登录页（hash 不动，重新登录后还在原来的页面）。
// 同时有好几个请求一起 401 时只提示一次。
setSessionLostHandler(() => {
  if (!sessionStore.get().me) return;
  sessionLost();
  toast.info("登录已失效，请重新登录");
});

// 没被接住的异步错误：别让它悄悄吞掉，至少给个提示
window.addEventListener("unhandledrejection", (event) => {
  console.error("未处理的异步错误", event.reason);
  toast.error(errorMessage(event.reason));
});

const root = document.getElementById("app");
if (!root) throw new Error("找不到挂载点 #app");
render(<App />, root);
