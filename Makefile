VENV ?= ../AIEnv
BIN := $(VENV)/bin

.PHONY: install test lint typecheck web-install web-build web-dev web-test bundle-web engine app apk build-app smoke-app

install:
	$(BIN)/pip install -e ".[dev]"

test:
	$(BIN)/pytest -q

lint:
	$(BIN)/ruff check src tests scripts

typecheck:
	$(BIN)/mypy
	cd apps/web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit

web-install:
	cd apps/web && npm install

web-build:
	cd apps/web && npm run build

web-dev:   # needs `make engine` running for the local engine; the browser engine works on its own
	cd apps/web && npm run dev

web-test:
	cd apps/web && npm test

bundle-web:
	$(BIN)/python scripts/bundle_web.py

engine:
	$(BIN)/flowlabs engine --port 8899

app:
	$(BIN)/flowlabs app

apk:
	$(BIN)/python scripts/build_apk.py

build-app:
	$(BIN)/python scripts/build_app.py

smoke-app:
	$(BIN)/python scripts/smoke_app.py
