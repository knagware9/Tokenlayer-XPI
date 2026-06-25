# TokenLayer XPI — deployment automation.
# See DEPLOY.md for details. `make help` lists targets.

COMPOSE      := docker compose -f docker-compose.yml
COMPOSE_BESU := docker compose -f docker-compose.yml -f docker-compose.besu.yml

.DEFAULT_GOAL := help
.PHONY: help deploy deploy-besu verify verify-besu down down-besu besu-up besu-down logs status rebuild

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

deploy: ## Deploy the stack on simulated ledgers (one command)
	./scripts/deploy.sh

deploy-besu: ## Deploy + run the 'besu' chain on the real 5-node QBFT network
	./scripts/deploy.sh --besu

verify: ## Smoke test the running deployment (issue + buy)
	./scripts/verify.sh

verify-besu: ## Smoke test and assert real on-chain contract deployment
	./scripts/verify.sh --besu

besu-up: ## Start only the external 5-node Besu network
	docker compose -f $${BESU_PROJECT_DIR:-/Users/kamleshnagware/deposittokenization}/docker-compose.yml \
	  --project-directory $${BESU_PROJECT_DIR:-/Users/kamleshnagware/deposittokenization} \
	  up -d besu-node1 besu-node2 besu-node3 besu-node4 besu-node5

besu-down: ## Stop the external 5-node Besu network
	docker compose -f $${BESU_PROJECT_DIR:-/Users/kamleshnagware/deposittokenization}/docker-compose.yml \
	  --project-directory $${BESU_PROJECT_DIR:-/Users/kamleshnagware/deposittokenization} \
	  stop besu-node1 besu-node2 besu-node3 besu-node4 besu-node5

status: ## Show running containers
	$(COMPOSE_BESU) ps

logs: ## Tail API + web logs
	$(COMPOSE_BESU) logs -f api web

rebuild: ## Rebuild images without cache and restart
	$(COMPOSE_BESU) build --no-cache && $(COMPOSE_BESU) up -d

down: ## Stop the app stack (keeps data volume)
	$(COMPOSE) down

down-besu: ## Stop the app stack started with the Besu overlay
	$(COMPOSE_BESU) down
