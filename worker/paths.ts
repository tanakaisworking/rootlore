// アプリの置き場所。LP は根（別の Worker）にあり、アプリは /v/ の下に置く。
//
// 根には、CLI とデスクトップ版が使う口（/.auth、/.config、/api/gh）だけを残す。
// 画面は /v/ の下で動き、その中の相対パス（.config、.fs、api/gh）も /v/ の下に来る。
// そのため、同じ口を根と /v の両方に置く（worker/index.ts）。

export const APP_PREFIX = "/v";

/** アプリの口を、根と /v の両方に置く。prefix は "" か "/v" */
export function appPaths(prefix: string) {
  return {
    config: `${prefix}/.config`,
    ping: `${prefix}/.ping`,
    logout: `${prefix}/.logout`,
    events: `${prefix}/.events`,
    logs: `${prefix}/.logs`,
    fs: `${prefix}/.fs`,
    fsAll: `${prefix}/.fs/*`,
    commit: `${prefix}/api/gh/commit`,
    move: `${prefix}/api/gh/move`,
    feedback: `${prefix}/api/feedback`,
    errors: `${prefix}/api/errors`,
    gh: `${prefix}/api/gh/*`,
  };
}
