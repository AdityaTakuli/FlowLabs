VENV ?= ../AIEnv
BIN := $(VENV)/bin

.PHONY: install test lint typecheck web-install web-build web-dev web-test bundle-web engine app apk build-app smoke-app local-app

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

local-app:   # build this checkout into the desktop app and install it here (Debian/Ubuntu; asks for your password)
	cd apps/web && npm run build
	$(BIN)/python scripts/bundle_web.py
	$(BIN)/python scripts/build_app.py --no-web
	$(BIN)/python scripts/smoke_app.py
	sudo apt install -y ./dist/FlowLabs-$$($(BIN)/python -c "import sys; sys.path.insert(0, 'src'); from flowlabs import __version__; print(__version__)")-linux-amd64.deb
