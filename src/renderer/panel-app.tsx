import { useState } from "react";
import { useBusiness } from "./state";
import { useWidgetDrafts } from "./widget-drafts";
import { WidgetStudio } from "./widget-studio";
import { useAppearance } from "./appearance";
import { useOverlayOpen } from "./main-shell";
import { Icon } from "./icons";

/**
 * The menu bar panel (WB-03, OD-168/OD-169): the retained widgets of the one workbench, their own light
 * interactions and their order. Asking, projects, Coding, pending items, settings and every widget
 * management step live in the main window, which the panel opens on the same object.
 */
export function PanelApp() {
  const model = useBusiness();
  const { snapshot, status } = model;
  const widgetDrafts = useWidgetDrafts(snapshot, model.setExternalDirty);
  const overlayOpen = useOverlayOpen();
  const [notice, setNotice] = useState("");
  useAppearance(snapshot?.settings.appearance ?? window.desktop.appearance);
  const openMain = () => void window.desktop.openMain();
  return (
    <div className="app panel-app">
      <main className="shell">
        {!status.connected && (
          <div className="service-error" role="alert">
            <span>{status.message}</span>
            <button
              onClick={() => {
                void window.desktop.reconnect();
              }}
            >
              重新连接
            </button>
          </div>
        )}
        {model.actionError && (
          <div className="service-error" role="alert">
            <span>{model.actionError}</span>
            <button onClick={model.clearActionError}>关闭提示</button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setNotice("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        <div className="viewport">
          <WidgetStudio
            panel
            snapshot={snapshot}
            connected={status.connected}
            model={widgetDrafts}
            section="widgets"
            onSelect={openMain}
            onSection={openMain}
            openSettings={openMain}
            occluded={overlayOpen}
          />
        </div>
      </main>
    </div>
  );
}
