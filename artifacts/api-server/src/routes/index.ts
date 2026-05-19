import { Router, type IRouter } from "express";
import healthRouter from "./health";
import editorialRouter from "./editorial";
import feedsRouter from "./feeds";
import weatherRouter from "./weather";
import affiliateRouter from "./affiliate";

const router: IRouter = Router();

router.use(healthRouter);
router.use(editorialRouter);
router.use(feedsRouter);
router.use(weatherRouter);
router.use(affiliateRouter);

export default router;
