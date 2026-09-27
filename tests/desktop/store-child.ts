import { Store } from "../../src/service/store";
try {
  const store = new Store(process.argv[2]);
  process.send?.({ ready: true });
  process.on("message", () => {
    store.close();
    process.exit(0);
  });
  process.on("disconnect", () => {
    store.close();
    process.exit(0);
  });
} catch (error) {
  process.send?.({ error: (error as Error).message });
  process.exit(1);
}
