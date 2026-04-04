import { Router } from "express";

export const healthRoutes = Router();

healthRoutes.get("/", (_request, response) => {
  response.json({
    ok: true,
    service: "api",
    timestamp: new Date().toISOString(),
  });
});
