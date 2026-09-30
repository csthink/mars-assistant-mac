/** Session navigation only. The trusted Electron document URL stays unchanged. */
export function taskRoute(): {
  project: string;
  object: string;
  view: string;
} | null {
  try {
    const value = JSON.parse(sessionStorage.getItem("task-route") ?? "null");
    return value &&
      typeof value.project === "string" &&
      typeof value.object === "string" &&
      ["flow", "detail"].includes(value.view)
      ? { project: value.project, object: value.object, view: value.view }
      : null;
  } catch {
    return null;
  }
}
export function clearTaskRoute() {
  sessionStorage.removeItem("task-route");
}
