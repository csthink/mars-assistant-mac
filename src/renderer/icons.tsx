const icons: Record<string, string> = {
  folder: "M3 7V5h7l2 3h9v12H3Z",
  chevronDown: "m6 9 6 6 6-6",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  archive: "M3 3h18v5H3ZM5 8v13h14V8M9 12h6",
  pin: "M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6ZM12 14v7",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
  chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z",
  grid: "M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z",
  inbox: "M4 4h16l2 12v4H2v-4ZM2 16h6l2 3h4l2-3h6",
  list: "M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1",
  note: "M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  plus: "M12 4v16M4 12h16",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6",
  arrow: "M12 20V4M5 11l7-7 7 7",
  edit: "m4 16 12-12 4 4L8 20H4ZM13 7l4 4",
  compose:
    "M14 4l6 6 M12 18l-6 1 1-6L17 3a2 2 0 0 1 4 4z M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l4 2",
  link: "m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  gauge: "M4 17a8 8 0 1 1 16 0M12 17l4-6",
  panel: "M3 4h18v16H3ZM9 4v16",
  close: "M5 5l14 14M19 5 5 19",
  check: "m5 12 4 4L19 6",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  home: "M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5",
  sidebar: "M4 5h16v14H4ZM10 5v14",
  panelRight: "M4 5h16v14H4ZM14 5v14",
  widen: "M4 12h16M7.5 8.5 4 12l3.5 3.5M16.5 8.5 20 12l-3.5 3.5",
  narrow: "M4 12h6M20 12h-6M7 8.5 10.5 12 7 15.5M17 8.5 13.5 12l3.5 3.5",
  takeover: "M4 5h16v14H4ZM9 5v14M14 9.5 11.5 12l2.5 2.5",
  file: "M7 4h7.5L19 8.5V20H7ZM14.5 4v4.5H19",
  activity: "M3.5 12h3.8l2.4-6 4.6 12 2.4-6h3.8",
};
export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={icons[name] ?? icons.spark} />
    </svg>
  );
}
