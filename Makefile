SRC := build/ tests/
CLEAN := htmlcov/ .coverage .ruff_cache/ .pytest_cache/ __pycache__/
PORT ?= 8080

.PHONY: help
help:
	@echo "Usage: $(MAKE) <data | data-cached | serve | test | lint | format | clean>"
	@echo ""
	@echo "  data         fetch both upstreams and rebuild site/data/"
	@echo "  data-cached  rebuild from build/.cache/ without refetching"
	@echo "  serve        serve site/ at http://localhost:$(PORT)"
	@echo "  test         run the Python and JS test suites"
	@echo "  test-visual  run the Playwright layout suite (real browser)"
	@echo "  lint         format, then type-check"
	@echo "  clean        remove caches and build artifacts"

.PHONY: data
data:
	uv run python -m build.build

.PHONY: data-cached
data-cached:
	uv run python -m build.build --cache

# The page fetches its data over HTTP, so opening index.html from the
# filesystem will not work -- the fetches are blocked as cross-origin.
.PHONY: serve
serve:
	@echo "http://localhost:$(PORT)"
	@python3 -m http.server $(PORT) --directory site

.PHONY: format
format:
	uv run --group dev ruff format $(SRC)
	uv run --group dev ruff check --fix $(SRC)

.PHONY: lint
lint: format
	uv run --group dev pyright

.PHONY: test
test: test-py test-js

.PHONY: test-py
test-py:
	uv run --group dev pytest

# Pure logic runs bare; the render tests mount site/index.html in jsdom.
.PHONY: test-js
test-js: node_modules
	node --test tests/*.test.mjs

node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

# Real browser: layout, stacking and computed colour. Downloads Chromium on
# first run, so it is kept out of `make test`.
.PHONY: test-visual
test-visual: node_modules
	npx playwright install chromium
	npx playwright test

.PHONY: clean
clean:
	@rm -rf $(CLEAN)
	@find $(SRC) -type d -name __pycache__ -print0 | xargs -0 -n1 -P0 rm -rf

.PHONY: check
check: clean lint test
