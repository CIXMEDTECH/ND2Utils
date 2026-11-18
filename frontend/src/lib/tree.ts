import { parentPath } from "./format";
import type { FileSummary } from "./types";

export interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  files: FileSummary[];
  /** ND2 files in this folder and all subfolders. */
  total: number;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });

let lastTree: { folders: string[]; files: FileSummary[]; tree: FolderNode } | null = null;

/**
 * The folder tree of the workspace. The file tree, keyboard navigation and the background
 * cache all ask for it after every refresh; the result is shared while the inputs are the
 * same objects (the store keeps them when nothing changed).
 */
export function buildTree(folders: string[], files: FileSummary[]): FolderNode {
  if (lastTree && lastTree.folders === folders && lastTree.files === files) return lastTree.tree;
  const tree = computeTree(folders, files);
  lastTree = { folders, files, tree };
  return tree;
}

function computeTree(folders: string[], files: FileSummary[]): FolderNode {
  const root: FolderNode = { path: "", name: "", folders: [], files: [], total: 0 };
  const nodes = new Map<string, FolderNode>([["", root]]);
  const ensure = (path: string): FolderNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: FolderNode = { path, name: path.slice(path.lastIndexOf("/") + 1), folders: [], files: [], total: 0 };
    nodes.set(path, node);
    ensure(parentPath(path)).folders.push(node);
    return node;
  };
  folders.forEach(ensure);
  for (const file of files) ensure(file.folder || "").files.push(file);
  const finish = (node: FolderNode): number => {
    node.folders.sort(byName);
    node.files.sort(byName);
    node.total = node.files.length + node.folders.reduce((sum, child) => sum + finish(child), 0);
    return node.total;
  };
  finish(root);
  return root;
}

const orderedCache = new WeakMap<FolderNode, FileSummary[]>();

/** Files in display order (folders first, natural sort), e.g. for prefetching neighbours. */
export function orderedFiles(folders: string[], files: FileSummary[]): FileSummary[] {
  const tree = buildTree(folders, files);
  const hit = orderedCache.get(tree);
  if (hit) return hit;
  const out: FileSummary[] = [];
  const walk = (node: FolderNode) => {
    node.folders.forEach(walk);
    out.push(...node.files);
  };
  walk(tree);
  orderedCache.set(tree, out);
  return out;
}

export function countFilesIn(files: FileSummary[], folder: string): number {
  if (!folder) return files.length;
  return files.filter((f) => f.folder === folder || f.folder.startsWith(`${folder}/`)).length;
}
