import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import socialRouter from "./social";
import newsletterRouter from "./newsletter";
import affiliateIngestRouter from "./affiliate-ingest";
import feedsRouter from "./feeds";
import weatherRouter from "./weather";
import affiliateRouter from "./affiliate";
import favoritesRouter from "./favorites";
import commentaryRouter from "./commentary";
import translateArticleRouter from "./translate-article";
import subscribeRouter from "./subscribe";
import youtubeRouter from "./youtube";
import contactRouter from "./contact";
import opsFinanceRouter from "./ops-finance";
import pushRouter from "./push";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(socialRouter);
router.use(newsletterRouter);
router.use(affiliateIngestRouter);
router.use(feedsRouter);
router.use(weatherRouter);
router.use(affiliateRouter);
router.use(favoritesRouter);
router.use(commentaryRouter);
router.use(translateArticleRouter);
router.use(subscribeRouter);
router.use(youtubeRouter);
router.use(contactRouter);
router.use(opsFinanceRouter);
router.use(pushRouter);

export default router;
