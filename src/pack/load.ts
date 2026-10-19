import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { EffortTier } from "../config.js";

export interface RoleManifest {
  id: string;
  summary: string;
  prompt: string;
  kinds: string[];
  tiers: EffortTier[];
  families: string[];
  needs: string[];
  write_scope: string[];
  forbidden: string[];
  gates: string[];
  standing: string[];
  read_only?: boolean;
}

export interface DomainPack {
  path: string;
  roles: Record<string, { manifest: RoleManifest; prompt: string }>;
}

/** Load JSON manifests and their sibling Markdown prompts; never execute pack content. */
export function loadPack(path: string, cwd = process.cwd()): DomainPack {
  const root = resolve(cwd, path);
  const rolesDir = resolve(root, "roles");
  const roles: DomainPack["roles"] = Object.create(null);
  let files: string[];
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    files = readdirSync(rolesDir).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    throw new Error(`pack ${root}: ${String(error)}`);
  }
  const errors: string[] = [];
  for (const file of files) {
    try {
      const value = JSON.parse(readFileSync(resolve(rolesDir, file), "utf8").replace(/^\uFEFF/, ""));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest must be an object");
      for (const field of ["id", "summary", "prompt"]) {
        if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`${field} must be a non-empty string`);
      }
      if (!/^[a-z][a-z0-9-]*$/.test(value.id) || value.id !== basename(file, ".json")) {
        throw new Error("id must be a lowercase role slug matching the manifest filename");
      }
      if (!/^[a-zA-Z0-9_-]+\.md$/.test(value.prompt)) throw new Error("prompt must name a sibling .md file");
      for (const field of ["kinds", "tiers", "families", "needs", "write_scope", "forbidden", "gates", "standing"]) {
        if (!Array.isArray(value[field]) || !value[field].every((item: unknown) => typeof item === "string" && item.trim())) {
          throw new Error(`${field} must be an array of non-empty strings`);
        }
      }
      if (!value.tiers.every((tier: string) => ["free", "cheap", "standard", "lead"].includes(tier))) {
        throw new Error("tiers must contain only free, cheap, standard, lead");
      }
      if (!value.kinds.every((kind: string) => ["code", "asset", "design-data", "qa", "prototype", "docs"].includes(kind))) {
        throw new Error("kinds contains an unknown ticket kind");
      }
      if (value.read_only !== undefined && typeof value.read_only !== "boolean") throw new Error("read_only must be a boolean");
      roles[value.id] = { manifest: value as RoleManifest, prompt: readFileSync(resolve(rolesDir, value.prompt), "utf8") };
    } catch (error) {
      errors.push(`${resolve(rolesDir, file)}: ${String(error)}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  return { path: root, roles };
}
