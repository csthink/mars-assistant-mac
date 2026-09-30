import { createContext, useContext, type RefObject } from "react";
import type { ColumnLayout } from "./column-layout";

/** Shared shell state. Project browsing does not issue domain commands. */
export interface ProjectColumns {
  host: HTMLDivElement | null;
  open: boolean;
  layout: ColumnLayout;
  panelRef: RefObject<HTMLElement | null>;
  toggleRef: RefObject<HTMLButtonElement | null>;
  takeoverRef: RefObject<HTMLButtonElement | null>;
  setAvailable: (available: boolean) => void;
  setFull: (full: boolean) => void;
  setOpen: (open: boolean) => void;
  setTakeover: (takeover: boolean) => void;
  toggle: () => void;
  close: () => void;
  width: (width: number | null) => void;
  preview: (width: number | null) => void;
}
export const ProjectColumnsContext = createContext<ProjectColumns | null>(null);
export const useProjectColumns = () => useContext(ProjectColumnsContext);
