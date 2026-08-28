import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { PATHS, readJson, writeJson } from "../lib/persistence";

const router: IRouter = Router();

export interface AffiliateItem {
  id: string;
  title: string;
  description: string;
  descriptionEs?: string;   // ES-mirror: Spanish blurb rendered on /es/affiliate pages
  category: string;
  smartStrip: string;
  affiliateLink: string;
  imageUrl: string;
  featured: boolean;
  createdAt: string;
  sortOrder: number;
}

interface AffiliateStore {
  items: AffiliateItem[];
}

async function getStore(): Promise<AffiliateStore> {
  return readJson<AffiliateStore>(PATHS.affiliateItems, { items: [] });
}

async function saveStore(store: AffiliateStore): Promise<void> {
  await writeJson(PATHS.affiliateItems, store);
}

function checkToken(req: Request): boolean {
  const token = process.env["AGENT_APPROVAL_TOKEN"];
  if (!token) return true;
  const provided = req.headers["x-affiliate-token"] || req.query["token"];
  return provided === token;
}

router.get("/affiliate-items", async (req: Request, res: Response) => {
  try {
    const store = await getStore();
    let items = store.items;

    const { category, featured } = req.query;
    if (category) items = items.filter((i) => i.category === String(category));
    if (featured === "true") items = items.filter((i) => i.featured);

    items = [...items].sort((a, b) => a.sortOrder - b.sortOrder);

    res.json({ success: true, count: items.length, items });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post("/affiliate-items", async (req: Request, res: Response) => {
  if (!checkToken(req)) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    const { title, description, descriptionEs, category, smartStrip, affiliateLink, imageUrl, featured, sortOrder } = req.body;
    if (!title || !category) {
      res.status(400).json({ success: false, error: "title and category are required" });
      return;
    }
    const store = await getStore();
    const item: AffiliateItem = {
      id: crypto.randomUUID(),
      title: String(title),
      description: String(description || ""),
      descriptionEs: descriptionEs ? String(descriptionEs) : "",
      category: String(category),
      smartStrip: String(smartStrip || ""),
      affiliateLink: String(affiliateLink || ""),
      imageUrl: String(imageUrl || ""),
      featured: Boolean(featured),
      createdAt: new Date().toISOString(),
      sortOrder: typeof sortOrder === "number" ? sortOrder : store.items.length,
    };
    store.items.push(item);
    await saveStore(store);
    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.patch("/affiliate-items/:id", async (req: Request, res: Response) => {
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
    const { title, description, descriptionEs, category, smartStrip, affiliateLink, imageUrl, featured, sortOrder } = req.body;
    const item = store.items[idx];
    if (item) {
      if (title !== undefined) item.title = String(title);
      if (description !== undefined) item.description = String(description);
      if (descriptionEs !== undefined) item.descriptionEs = String(descriptionEs);
      if (category !== undefined) item.category = String(category);
      if (smartStrip !== undefined) item.smartStrip = String(smartStrip);
      if (affiliateLink !== undefined) item.affiliateLink = String(affiliateLink);
      if (imageUrl !== undefined) item.imageUrl = String(imageUrl);
      if (featured !== undefined) item.featured = Boolean(featured);
      if (sortOrder !== undefined) item.sortOrder = Number(sortOrder);
    }
    await saveStore(store);
    res.json({ success: true, item: store.items[idx] });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.delete("/affiliate-items/:id", async (req: Request, res: Response) => {
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
