import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { PATHS, readJson, writeJson } from "../lib/persistence";

const router: IRouter = Router();

export interface FavoriteItem {
  id: string;
  title: string;
  url: string;
  category: "youtube-channels" | "cruise-websites";
  description: string;
  imageUrl: string;
  sortOrder: number;
  createdAt: string;
}

interface FavoritesStore {
  items: FavoriteItem[];
}

async function getStore(): Promise<FavoritesStore> {
  return readJson<FavoritesStore>(PATHS.favorites, { items: [] });
}

async function saveStore(store: FavoritesStore): Promise<void> {
  await writeJson(PATHS.favorites, store);
}

function checkToken(req: Request): boolean {
  const token = process.env["AGENT_APPROVAL_TOKEN"];
  if (!token) return true;
  const provided = req.headers["x-affiliate-token"] || req.query["token"];
  return provided === token;
}

router.get("/favorites", async (req: Request, res: Response) => {
  try {
    const store = await getStore();
    let items = store.items;
    const { category } = req.query;
    if (category) items = items.filter((i) => i.category === String(category));
    items = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
    res.json({ success: true, count: items.length, items });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post("/favorites", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const { title, url, category, description, imageUrl, sortOrder } = req.body;
    if (!title || !url || !category) {
      res.status(400).json({ success: false, error: "title, url, and category are required" });
      return;
    }
    const store = await getStore();
    const item: FavoriteItem = {
      id: crypto.randomUUID(),
      title: String(title),
      url: String(url),
      category: String(category) as FavoriteItem["category"],
      description: String(description || ""),
      imageUrl: String(imageUrl || ""),
      sortOrder: typeof sortOrder === "number" ? sortOrder : store.items.length,
      createdAt: new Date().toISOString(),
    };
    store.items.push(item);
    await saveStore(store);
    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.patch("/favorites/:id", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const store = await getStore();
    const idx = store.items.findIndex((i) => i.id === req.params["id"]);
    if (idx === -1) {
      res.status(404).json({ success: false, error: "Item not found" });
      return;
    }
    const { title, url, category, description, imageUrl, sortOrder } = req.body;
    const item = store.items[idx];
    if (item) {
      if (title !== undefined) item.title = String(title);
      if (url !== undefined) item.url = String(url);
      if (category !== undefined) item.category = String(category) as FavoriteItem["category"];
      if (description !== undefined) item.description = String(description);
      if (imageUrl !== undefined) item.imageUrl = String(imageUrl);
      if (sortOrder !== undefined) item.sortOrder = Number(sortOrder);
    }
    await saveStore(store);
    res.json({ success: true, item: store.items[idx] });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.delete("/favorites/:id", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const store = await getStore();
    const before = store.items.length;
    store.items = store.items.filter((i) => i.id !== req.params["id"]);
    if (store.items.length === before) {
      res.status(404).json({ success: false, error: "Item not found" });
      return;
    }
    await saveStore(store);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
