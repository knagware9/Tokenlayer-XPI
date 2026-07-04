# TokenLayer XPI — deployment automation.
# See DEPLOY.md for details. `make help` lists targets.

COMPOSE      := docker compose -f docker-compose.yml
COMPOSE_BESU := docker compose -f docker-compose.yml -f docker-compose.besu.yml

.DEFAULT_GOAL := help
.PHONY: help deploy deploy-besu deploy-sim verify verify-sim down down-besu besu-up besu-down fabric-up fabric-down logs status rebuild

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

deploy: ## Deploy on the REAL 5-node Besu QBFT network (default)
	./scripts/deploy.sh

deploy-besu: ## Alias of deploy
	./scripts/deploy.sh

deploy-sim: ## Deploy on simulated ledgers only (no external chain)
	./scripts/deploy.sh --sim

verify: ## Smoke test: issue + buy, assert real on-chain contract
	./scripts/verify.sh --besu

verify-sim: ## Smoke test against the simulated stack
	./scripts/verify.sh

besu-up: ## Start only the external 5-node Besu network
	docker compose -f $${BESU_PROJECT_DIR:-/Users/kamleshnagware/deposittokenization}/docker-compose.yml \
	  --project-directory $${BESU_PROJECT_DIR:-/Users/kamleshnagware/deposittokenization} \
	  up -d besu-node1 besu-node2 besu-node3 besu-node4 besu-node5

besu-down: ## Stop the external 5-node Besu network
	docker compose -f $${BESU_PROJECT_DIR:-/Users/kamleshnagware/deposittokenization}/docker-compose.yml \
	  --project-directory $${BESU_PROJECT_DIR:-/Users/kamleshnagware/deposittokenization} \
	  stop besu-node1 besu-node2 besu-node3 besu-node4 besu-node5

fabric-up: ## Bring up a real Hyperledger Fabric network + deploy the tokenlayer chaincode
	./infra/fabric/fabric-up.sh

fabric-down: ## Tear down the Fabric network and remove runtime artifacts
	./infra/fabric/fabric-down.sh

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
