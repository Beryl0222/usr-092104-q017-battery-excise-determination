// HTTP 适配层：命令 → TaxService，查询 → QueryService。
// 鉴权信息经请求头传递：x-user-id、x-user-roles（逗号分隔）。
// 该层不含业务规则，所有不变量在领域/应用层执行。

import { createServer } from "node:http";

export function createApp(service, query) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const actor = readActor(req);
    try {
      // ---------- 查询 ----------
      if (req.method === "GET" && url.pathname === "/api/health") return ok(res, { status: "ok" });

      if (req.method === "GET" && url.pathname === "/api/events")
        return ok(res, service.store.all());

      if (req.method === "GET" && url.pathname === "/api/filings")
        return ok(res, query.listFilings());

      let m;
      if (req.method === "GET" && (m = url.pathname.match(/^\/api\/profiles\/([^/]+)\/proposal$/))) {
        const result = query.proposal({
          profile_id: decodeURIComponent(m[1]),
          as_of: url.searchParams.get("as_of") || undefined,
          rule_code: url.searchParams.get("rule_code") || undefined,
        });
        return respond(res, result.ok ? 200 : result.status || 422, result);
      }
      if (req.method === "GET" && url.pathname === "/api/replay") {
        const result = query.replay({
          profile_id: url.searchParams.get("profile_id"),
          category: url.searchParams.get("category"),
          at: url.searchParams.get("at"),
          rule_code: url.searchParams.get("rule_code") || undefined,
        });
        return respond(res, result.ok ? 200 : result.status || 422, result);
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/api\/entries\/([^/]+)\/explain$/))) {
        const result = query.explain(decodeURIComponent(m[1]));
        return respond(res, result.ok ? 200 : 404, result);
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/api\/entries\/([^/]+)\/chain$/))) {
        const result = query.chain(decodeURIComponent(m[1]));
        if (!result) return respond(res, 404, { ok: false, error: "分录不存在" });
        return ok(res, result);
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/api\/lots\/([^/]+)\/audit$/))) {
        const result = query.auditLot(decodeURIComponent(m[1]));
        return respond(res, result.ok ? 200 : 404, result);
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/api\/lots\/([^/]+)\/bom$/))) {
        const result = query.bom(decodeURIComponent(m[1]));
        if (!result) return respond(res, 404, { ok: false, error: "批次不存在" });
        return ok(res, result);
      }

      if (req.method !== "POST") return respond(res, 404, { ok: false, error: "未找到路由" });

      // ---------- 命令 ----------
      const body = await readJson(req);
      let out;
      switch (url.pathname) {
        case "/api/rules":
          out = await service.registerRule(actor, body); break;
        case "/api/profiles":
          out = await service.registerProfile(actor, body); break;
        case "/api/evidence":
          out = await service.attachEvidence(actor, body); break;
        case "/api/classifications/sign":
          out = await service.signClassification(actor, body); break;
        case "/api/lots":
          out = await service.recordLot(actor, body); break;
        case "/api/lots/complete":
          out = await service.completeLot(actor, body); break;
        case "/api/bom-links":
          out = await service.linkBom(actor, body); break;
        case "/api/lots/usage":
          out = await service.changeUsage(actor, body); break;
        case "/api/supplies":
          out = await service.recordContract(actor, body); break;
        case "/api/invoices":
          out = await service.issueInvoice(actor, body); break;
        case "/api/dispatches":
          out = await service.dispatch(actor, body); break;
        case "/api/calculate":
          out = await service.calculateForSupply(actor, body); break;
        case "/api/entries/reverse":
          out = await service.reverseEntry(actor, body); break;
        case "/api/entries/supplement":
          out = await service.addSupplement(actor, body); break;
        case "/api/reviews":
          out = await service.recordReview(actor, body); break;
        case "/api/filings":
          out = await service.submitFiling(actor, body); break;
        case "/api/filings/settle":
          out = await service.settleFiling(actor, body); break;
        case "/api/warehouse/events": {
          const { WarehouseAdapter } = await import("../application/warehouseAdapter.js");
          out = await new WarehouseAdapter(service).ingest(actor, body);
          break;
        }
        default:
          return respond(res, 404, { ok: false, error: "未找到路由" });
      }
      return ok(res, { ok: true, events: out });
    } catch (err) {
      const status =
        err.code === "FORBIDDEN" ? 403
        : err.code === "VALIDATION_FAILED" ? 422
        : err.code === "RULE_INTERVAL_OVERLAP" ? 409
        : err.code === "FILING_INVALID" || err.code === "FILING_TOTAL_MISMATCH" ? 422
        : err.code?.startsWith("BOUNDARY") ? 422
        : 400;
      return respond(res, status, {
        ok: false,
        error: err.message,
        code: err.code || null,
        ...(err.proposal ? { proposal: summarizeProposal(err.proposal) } : {}),
        ...(err.errors ? { errors: err.errors } : {}),
      });
    }
  });
}

function summarizeProposal(p) {
  return {
    profile_id: p.profile_id,
    rule_version: p.rule_version,
    candidates: p.candidates,
    missing_evidence: p.missing_evidence,
    boundary: p.boundary,
  };
}

function readActor(req) {
  const id = req.headers["x-user-id"] || "anonymous";
  const roles = String(req.headers["x-user-roles"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { id, roles };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function ok(res, body) {
  return respond(res, 200, body);
}

function respond(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}
