VENV ?= ../AIEnv
BIN := $(VENV)/bin

.PHONY: install test lint format typecheck catalogue fixtures demo clean

install:
	$(BIN)/pip install -e ".[dev]"

test:
	$(BIN)/pytest -q

lint:
	$(BIN)/ruff check packages tests fixtures

format:
	$(BIN)/ruff format packages tests fixtures

typecheck:
	$(BIN)/mypy

catalogue:
	$(BIN)/flowlab catalogue --out packages/nodes/nodes.schema.json

fixtures:
	$(BIN)/python fixtures/generate.py

demo:
	$(BIN)/flowlab run examples/churn_flow.json --data fixtures
	-$(BIN)/flowlab compile examples/leaky_flow.json --data fixtures

clean:
	rm -rf runs .flowlab .pytest_cache .mypy_cache .ruff_cache
