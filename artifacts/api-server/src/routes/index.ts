import { Router, type IRouter } from "express";
import healthRouter from "./health";
import editorialRouter from "./editorial";
import feedsRouter from "./feeds";
import weatherRouter from "./weather";
import affiliateRouter from "./affiliate";
import favoritesRouter from "./favorites";
import commentaryRouter from "./commentary";
import translateArticleRouter from "./translate-article";
import subscribeRouter from "./subscribe";
import youtubeRouter from "./youtube";
import contactRouter from "./contact";

const router: IRouter = Router();

router.use(healthRouter);
router.use(editorialRouter);
router.use(feedsRouter);
router.use(weatherRouter);
router.use(affiliateRouter);
router.use(favoritesRouter);
router.use(commentaryRouter);
router.use(translateArticleRouter);
router.use(subscribeRouter);
router.use(youtubeRouter);
router.use(contactRouter);

export default router;
