VENV ?= ../AIEnv
BIN := $(VENV)/bin
ROOT ?= .

.PHONY: install test lint format typecheck catalogue fixtures demo clean web-install web-build web-dev web-test serve

install:
	$(BIN)/pip install -e ".[dev]"

test:
	$(BIN)/pytest -q

lint:
	$(BIN)/ruff check packages apps/api tests fixtures

format:
	$(BIN)/ruff format packages apps/api tests fixtures

typecheck:
	$(BIN)/mypy
	cd apps/web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit

catalogue:
	$(BIN)/flowlab catalogue --out packages/nodes/nodes.schema.json

fixtures:
	$(BIN)/python fixtures/generate.py

demo:
	$(BIN)/flowlab run examples/churn_flow.json --data fixtures
	-$(BIN)/flowlab compile examples/leaky_flow.json --data fixtures

web-install:
	cd apps/web && npm install

web-build:
	cd apps/web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit && ./node_modules/.bin/vite build

web-dev:
	cd apps/web && ./node_modules/.bin/vite

web-test:
	cd apps/web && ./node_modules/.bin/vitest run

serve:
	$(BIN)/flowlab serve --root $(ROOT)

clean:
	rm -rf runs .flowlab .pytest_cache .mypy_cache .ruff_cache apps/web/dist

app:
	$(BIN)/python scripts/build_app.py

bundle-web:
	$(BIN)/python scripts/bundle_web.py

smoke-app:
	$(BIN)/python scripts/smoke_app.py
