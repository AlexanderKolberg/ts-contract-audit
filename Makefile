.PHONY: install check test demo audit pack smoke

CONFIG ?= examples/basic/ts-contract-audit.json
AUDIT_ARGS ?=

install:
	npm ci --ignore-scripts --no-audit --no-fund

check:
	@for file in bin/*.mjs src/*.mjs test/*.mjs scripts/*.mjs; do node --check "$$file" || exit; done
	$(MAKE) test

test:
	node --test test/*.test.mjs

demo:
	node bin/ts-contract-audit.mjs --config examples/basic/ts-contract-audit.json

audit:
	node bin/ts-contract-audit.mjs --config "$(CONFIG)" $(AUDIT_ARGS)

pack:
	mkdir -p tmp
	npm pack --ignore-scripts --pack-destination tmp

smoke: pack
	node scripts/packed-smoke.mjs
