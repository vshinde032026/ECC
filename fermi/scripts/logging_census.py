#!/usr/bin/env python3
"""logging_census.py — deterministic call-graph + logging census for a FastAPI service.

The mechanical substrate of fermi's flow-based logging sweep: builds the route/task
entry-point table, best-effort call chains, an inventory of every existing log
statement / except handler / print, and the mechanical violations of the
SuperStem/Fermi logging standard — all via AST, zero agents, zero imports of
target code.

Usage:
  python3 logging_census.py <service_root> --out census.json     # census (stdout: compact summary JSON)
  python3 logging_census.py <service_root> --lint                # lint mode: violations to stdout, exit 1 if any
  python3 logging_census.py <service_root> --lint --files a.py b.py   # lint only these files (CI / pre-commit)

<service_root> is the package dir, e.g. euler-api/app or backend/app.
Stdlib only. Python 3.9+.
"""
import argparse
import ast
import json
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", category=SyntaxWarning)  # LaTeX-heavy strings trip escape warnings

HTTP_METHODS = {"get", "post", "put", "delete", "patch", "head", "options", "websocket"}
LOG_LEVELS = {"debug", "info", "warning", "error", "exception", "critical"}
EXCLUDE_PARTS = {"__pycache__", "tests", "test", "migrations", "alembic"}
EXCLUDE_REL = ("core/monitoring",)  # platform code, R-028 — never a finding target
MAX_CHAIN_DEPTH = 6


def is_excluded(path: Path, root: Path) -> bool:
    rel = path.relative_to(root).as_posix()
    if any(p in EXCLUDE_PARTS for p in path.parts):
        return True
    if any(p.startswith(("_archived", "_deprecated", "_legacy")) for p in path.parts):
        return True
    return any(rel.startswith(e) or f"/{e}" in rel for e in EXCLUDE_REL)


def dotted(node):
    """Best-effort dotted name for a Name/Attribute chain, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


class FileCensus(ast.NodeVisitor):
    def __init__(self, relpath: str, pkg_name: str):
        self.relpath = relpath
        self.pkg = pkg_name
        self.routes = []       # {fn, method, line}
        self.tasks = []        # {fn, line}
        self.middleware = []   # {fn, line}
        self.signals = []      # {fn, line}
        self.imports = {}      # local name -> module dotted path
        self.functions = {}    # qualname -> {line, calls: [names], logs, has_depends}
        self.logs = []         # {line, level, constant_msg, fstring, exc_info, fn}
        self.excepts = []      # {line, kind: logged|pass|raise|return|silent, fn}
        self.violations = []   # {line, rule, detail}
        self.dynamic = []      # {line, pattern, fn}
        self._fn_stack = []

    # ---- imports ----------------------------------------------------------
    def visit_Import(self, node):
        for a in node.names:
            self.imports[a.asname or a.name.split(".")[0]] = a.name
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        mod = node.module or ""
        if node.level:  # relative import -> anchor at this file's package
            base = self.relpath.rsplit("/", 1)[0].replace("/", ".")
            for _ in range(node.level - 1):
                base = base.rsplit(".", 1)[0] if "." in base else ""
            mod = f"{self.pkg}.{base}.{mod}".strip(".") if base else f"{self.pkg}.{mod}".strip(".")
        for a in node.names:
            self.imports[a.asname or a.name] = f"{mod}.{a.name}" if mod else a.name
        self.generic_visit(node)

    # ---- defs -------------------------------------------------------------
    def _visit_fn(self, node):
        qual = ".".join([f for f in self._fn_stack] + [node.name])
        info = {"line": node.lineno, "calls": [], "depends": []}
        self.functions[qual] = info
        for dec in node.decorator_list:
            d = dec.func if isinstance(dec, ast.Call) else dec
            name = dotted(d) or ""
            attr = name.rsplit(".", 1)[-1]
            if isinstance(dec, ast.Call) and attr in HTTP_METHODS and ("router" in name or "app" in name or "api" in name):
                self.routes.append({"fn": qual, "method": attr, "line": node.lineno})
            elif attr in ("task", "shared_task"):
                self.tasks.append({"fn": qual, "line": node.lineno})
            elif attr == "middleware":
                self.middleware.append({"fn": qual, "line": node.lineno})
            elif attr == "connect":
                self.signals.append({"fn": qual, "line": node.lineno})
        # Depends(...) targets in the signature are call edges too
        for arg in list(node.args.args) + list(node.args.kwonlyargs):
            pass
        for default in list(node.args.defaults) + [d for d in node.args.kw_defaults if d]:
            if isinstance(default, ast.Call) and (dotted(default.func) or "").rsplit(".", 1)[-1] == "Depends":
                if default.args:
                    t = dotted(default.args[0])
                    if t:
                        info["depends"].append(t)
        self._fn_stack.append(node.name)
        self.generic_visit(node)
        self._fn_stack.pop()

    visit_FunctionDef = _visit_fn
    visit_AsyncFunctionDef = _visit_fn

    # ---- calls ------------------------------------------------------------
    def visit_Call(self, node):
        fn = ".".join(self._fn_stack) or "<module>"
        name = dotted(node.func)
        if name:
            root = name.split(".")[0]
            attr = name.rsplit(".", 1)[-1]
            if attr in LOG_LEVELS and ("logger" in root.lower() or root == "log" or "session_logger" in name.lower()):
                first = node.args[0] if node.args else None
                entry = {
                    "line": node.lineno, "level": attr, "fn": fn,
                    "constant_msg": isinstance(first, ast.Constant) and isinstance(first.value, str),
                    "fstring": isinstance(first, ast.JoinedStr),
                    "exc_info": any(k.arg == "exc_info" for k in node.keywords),
                }
                self.logs.append(entry)
                if entry["fstring"]:
                    self.violations.append({"line": node.lineno, "rule": "fstring-log", "detail": f"logger.{attr} with f-string message — constant message + extra={{}}"})
                if attr == "error" and entry["exc_info"]:
                    self.violations.append({"line": node.lineno, "rule": "error-exc-info", "detail": "logger.error(..., exc_info=True) — use logger.exception"})
            elif name == "logging.getLogger":
                self.violations.append({"line": node.lineno, "rule": "getLogger", "detail": "logging.getLogger — use app.core.monitoring.get_logger"})
            elif name == "logging.basicConfig":
                self.violations.append({"line": node.lineno, "rule": "basicConfig", "detail": "logging.basicConfig in served code"})
            elif name == "print":
                self.violations.append({"line": node.lineno, "rule": "print", "detail": "print() in served code"})
            elif name == "getattr" and len(node.args) >= 2:
                self.dynamic.append({"line": node.lineno, "pattern": "getattr-call", "fn": fn})
            if fn in self.functions and name not in ("print",):
                self.functions[fn]["calls"].append(name)
        elif isinstance(node.func, ast.Subscript):
            self.dynamic.append({"line": node.lineno, "pattern": "registry-dispatch", "fn": fn})
        self.generic_visit(node)

    # ---- excepts ----------------------------------------------------------
    def visit_ExceptHandler(self, node):
        fn = ".".join(self._fn_stack) or "<module>"
        has_log = any(
            isinstance(n, ast.Call) and (dotted(n.func) or "").rsplit(".", 1)[-1] in LOG_LEVELS
            for n in ast.walk(ast.Module(body=node.body, type_ignores=[]))
        )
        body = node.body
        if has_log:
            kind = "logged"
        elif len(body) == 1 and isinstance(body[0], ast.Pass):
            kind = "pass"
        elif len(body) == 1 and isinstance(body[0], ast.Raise) and body[0].exc is None:
            kind = "raise"
        elif all(isinstance(b, (ast.Return, ast.Continue, ast.Break, ast.Pass)) for b in body):
            kind = "return"
        else:
            kind = "silent"
        self.excepts.append({"line": node.lineno, "kind": kind, "fn": fn})
        if kind in ("pass", "return", "silent"):
            self.violations.append({"line": node.lineno, "rule": "except-no-log", "detail": f"except block with no log ({kind})"})
        self.generic_visit(node)


def module_to_file(mod: str, pkg: str, root: Path):
    """app.services.x -> <root>/services/x.py (or /__init__.py), else None."""
    if not mod.startswith(pkg + ".") and mod != pkg:
        return None
    rel = mod[len(pkg):].strip(".").replace(".", "/")
    for cand in (root / f"{rel}.py", root / rel / "__init__.py"):
        if cand.is_file():
            return cand
    # maybe last segment is a symbol, not a module
    if "/" in rel:
        head = rel.rsplit("/", 1)[0]
        for cand in (root / f"{head}.py", root / head / "__init__.py"):
            if cand.is_file():
                return cand
    return None


def run_census(root: Path):
    pkg = root.name
    files = {}
    for py in sorted(root.rglob("*.py")):
        if is_excluded(py, root):
            continue
        rel = py.relative_to(root).as_posix()
        try:
            tree = ast.parse(py.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError as e:
            files[rel] = {"error": f"syntax error: {e}"}
            continue
        c = FileCensus(rel, pkg)
        c.visit(tree)
        files[rel] = {
            "routes": c.routes, "tasks": c.tasks, "middleware": c.middleware, "signals": c.signals,
            "functions": c.functions, "logs": c.logs, "excepts": c.excepts,
            "violations": c.violations, "dynamic": c.dynamic, "imports": c.imports,
        }
    # resolve call edges file->file and walk chains from entry points
    edges = {}
    for rel, d in files.items():
        if "error" in d:
            continue
        out = set()
        for fn in d["functions"].values():
            for callee in fn["calls"] + fn["depends"]:
                target = d["imports"].get(callee.split(".")[0])
                if target:
                    f = module_to_file(target if "." in target else target, pkg, root)
                    if f:
                        t = f.relative_to(root).as_posix()
                        if t != rel:
                            out.add(t)
        edges[rel] = sorted(out)

    def chain(start):
        seen, frontier = {start}, [start]
        for _ in range(MAX_CHAIN_DEPTH):
            nxt = [t for f in frontier for t in edges.get(f, []) if t not in seen]
            if not nxt:
                break
            seen.update(nxt)
            frontier = nxt
        return sorted(seen)

    entrypoints = []
    for rel, d in files.items():
        if "error" in d:
            continue
        kinds = []
        if d["routes"] or any(True for _ in d.get("middleware", [])):
            kinds.append("router" if d["routes"] else "middleware")
        if d["tasks"]:
            kinds.append("task")
        if d["signals"]:
            kinds.append("signal")
        for kind in kinds:
            entrypoints.append({
                "path": rel, "kind": kind,
                "handlers": len(d["routes"]) if kind == "router" else len(d.get(kind + "s", d.get("tasks", []))),
                "chain": chain(rel),
            })
    all_violations = [dict(v, file=rel) for rel, d in files.items() if "error" not in d for v in d["violations"]]
    dynamic_sites = [dict(v, file=rel) for rel, d in files.items() if "error" not in d for v in d["dynamic"]]
    return {
        "root": str(root), "package": pkg, "files": files, "edges": edges,
        "entrypoints": entrypoints, "violations": all_violations, "dynamic_sites": dynamic_sites,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("service_root")
    ap.add_argument("--out", help="write full census JSON here")
    ap.add_argument("--lint", action="store_true", help="print mechanical violations, exit 1 if any")
    ap.add_argument("--files", nargs="*", help="lint only these files (relative to service_root or absolute)")
    args = ap.parse_args()
    root = Path(args.service_root).resolve()
    if not root.is_dir():
        sys.exit(f"not a directory: {root}")
    census = run_census(root)

    if args.lint:
        wanted = None
        if args.files:
            wanted = set()
            for f in args.files:
                p = Path(f)
                wanted.add((p if p.is_absolute() else Path.cwd() / p).resolve().relative_to(root).as_posix()
                           if (p if p.is_absolute() else Path.cwd() / p).resolve().is_relative_to(root)
                           else f)
        hits = [v for v in census["violations"] if wanted is None or v["file"] in wanted]
        for v in sorted(hits, key=lambda v: (v["file"], v["line"])):
            print(f"{v['file']}:{v['line']}: [{v['rule']}] {v['detail']}")
        print(f"\n{len(hits)} violation(s)", file=sys.stderr)
        sys.exit(1 if hits else 0)

    if args.out:
        Path(args.out).write_text(json.dumps(census, indent=1))
    summary = {
        "package": census["package"],
        "files": len(census["files"]),
        "entrypoints": [{"path": e["path"], "kind": e["kind"], "handlers": e["handlers"], "chain_size": len(e["chain"])} for e in census["entrypoints"]],
        "violations": len(census["violations"]),
        "violations_by_rule": {},
        "dynamic_sites": len(census["dynamic_sites"]),
        "census_file": args.out or None,
    }
    for v in census["violations"]:
        summary["violations_by_rule"][v["rule"]] = summary["violations_by_rule"].get(v["rule"], 0) + 1
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
