import { Router, type IRouter } from "express";
import healthRouter from "./health";
import editorialRouter from "./editorial";
import feedsRouter from "./feeds";
import weatherRouter from "./weather";
import affiliateRouter from "./affiliate";
import favoritesRouter from "./favorites";
import translateArticleRouter from "./translate-article";
import subscribeRouter from "./subscribe";

const router: IRouter = Router();

router.use(healthRouter);
router.use(editorialRouter);
router.use(feedsRouter);
router.use(weatherRouter);
router.use(affiliateRouter);
router.use(favoritesRouter);
router.use(translateArticleRouter);
router.use(subscribeRouter);

export default router;
