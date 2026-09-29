import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { openModal } from "./modal-focus";
import { Icon } from "./icons";

/** The settings categories, in their order; the main window's dialog and the menu bar panel share them. */
export const settingTabs = [
  "通用",
  "模型",
  "最近删除",
  "扩展管理",
  "访问权限",
  "数据保留",
  "数据与隐私",
];
/** The extension category's content title is "扩展"; other categories keep their name. */
export const settingTitles: Record<string, string> = { 扩展管理: "扩展" };

/** Category list: arrows, Home and End move between categories as a person expects of a vertical list. */
export function SettingsNav({
  tab,
  onTab,
}: {
  tab: string;
  onTab: (tab: string) => void;
}) {
  function keys(event: ReactKeyboardEvent<HTMLElement>) {
    // Move from the focused category (it may differ from the shown one after a pointer click elsewhere).
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    ];
    const focused = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const index = focused >= 0 ? focused : settingTabs.indexOf(tab);
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? (index + 1) % settingTabs.length
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? (index - 1 + settingTabs.length) % settingTabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? settingTabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    onTab(settingTabs[next]);
    buttons[next]?.focus();
  }
  return (
    <nav className="settings-nav" aria-label="设置分类" onKeyDown={keys}>
      {settingTabs.map((name) => (
        <button
          key={name}
          aria-current={tab === name ? "page" : undefined}
          className={tab === name ? "active" : ""}
          onClick={() => onTab(name)}
        >
          {name}
        </button>
      ))}
    </nav>
  );
}

/**
 * Settings as a modal dialog in the main window: the individual space line on top, categories on the left and
 * the chosen category on the right. A press that starts and ends outside the dialog, Escape and the close
 * button all close it, and focus returns to the control that opened it.
 */
export function SettingsDialog({
  tab,
  onTab,
  onClose,
  banners,
  children,
}: {
  tab: string;
  onTab: (tab: string) => void;
  onClose: () => void;
  /** Service and action notices: shown inside the dialog while it is open, so they are never behind it. */
  banners?: ReactNode;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  useEffect(() => openModal(dialog.current!), []);
  const outside = (event: { clientX: number; clientY: number }) => {
    const box = dialog.current?.getBoundingClientRect();
    return (
      !!box &&
      (event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom)
    );
  };
  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-labelledby="settings-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        backdropPress.current =
          event.target === event.currentTarget && outside(event);
      }}
      onPointerUp={(event) => {
        const closes =
          backdropPress.current &&
          event.target === event.currentTarget &&
          outside(event);
        backdropPress.current = false;
        if (closes) onClose();
      }}
    >
      <div className="settings-dialog-top">
        <h2 id="settings-dialog-title">设置</h2>
        <div className="settings-dialog-profile">
          <span className="settings-dialog-avatar" aria-hidden="true">
            我
          </span>
          <div>
            <strong>个人空间</strong>
            <small>保存在这台 Mac 上</small>
          </div>
        </div>
        <button
          className="icon-button"
          aria-label="关闭设置"
          title="关闭设置"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {banners}
      <div className="settings-dialog-body">
        <SettingsNav tab={tab} onTab={onTab} />
        <section
          className="settings-content settings-dialog-content"
          aria-label={tab}
        >
          <h2>{settingTitles[tab] ?? tab}</h2>
          {children}
        </section>
      </div>
    </dialog>
  );
}
