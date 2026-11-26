import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Tests run against the stand-ins in test/ (brand, script, product facts), never your own files in src/, so they pass
// before and after setup, whatever you fill in.
const standIn = (name: string) => ({ find: new RegExp(`^\\./${name}$`), replacement: fileURLToPath(new URL(`./test/${name}.ts`, import.meta.url)) });
export default defineConfig({
  resolve: { alias: [standIn("brand"), standIn("prompt"), standIn("knowledge")] },
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
