import { createAvatar } from "@dicebear/core";
import * as loaders from "@dicebear/collection/async";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Dicebear avatars, rendered client-side from (avatar_style, avatar_seed).
 *
 * Backend style names are kebab-case collection names ("pixel-art"); the
 * @dicebear/collection exports are camelCase ("pixelArt"). Styles are loaded
 * lazily via @dicebear/collection/async so each one is its own chunk.
 */
type Style = Parameters<typeof createAvatar>[0];
type Loader = () => Promise<Style>;

const LOADERS = loaders as unknown as Record<string, Loader | undefined>;
const FALLBACK = "notionists";

const styles = new Map<string, Style>();
const pending = new Map<string, Promise<void>>();
const uris = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

/** "pixel-art" -> "pixelArt" (the export names of @dicebear/collection). */
export function styleKey(style: string): string {
  const key = (style || FALLBACK).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return LOADERS[key] ? key : FALLBACK;
}

function load(key: string): Promise<void> {
  let p = pending.get(key);
  if (!p) {
    p = LOADERS[key]!()
      .then((mod) => {
        styles.set(key, mod);
        version++;
        listeners.forEach((l) => l());
      })
      .catch(() => {
        pending.delete(key);
      });
    pending.set(key, p);
  }
  return p;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function render(key: string, seed: string): string | null {
  const impl = styles.get(key);
  if (!impl) return null;
  const cacheKey = `${key}|${seed}`;
  let uri = uris.get(cacheKey);
  if (!uri) {
    uri = createAvatar(impl, { seed: seed || "git-team" }).toDataUri();
    if (uris.size > 1000) uris.clear();
    uris.set(cacheKey, uri);
  }
  return uri;
}

/** Data URI for a dicebear avatar, or null while the style chunk is loading. */
export function useDicebearUri(style: string, seed: string, enabled = true): string | null {
  useSyncExternalStore(subscribe, () => version);
  const key = styleKey(style);
  const ready = styles.has(key);
  useEffect(() => {
    if (enabled && !ready) void load(key);
  }, [enabled, ready, key]);
  return enabled ? render(key, seed) : null;
}
