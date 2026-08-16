# Piggy — dev entry points. On Windows, run these from Git Bash.
.DEFAULT_GOAL := help

UV := uv
COMPOSE := docker compose

help:
	@echo "Piggy"
	@echo ""
	@echo "Setup:"
	@echo "  make install        uv sync + npm install"
	@echo "  make env            copy .env.example to .env"
	@echo "  make seed email=you@example.com name='You'   create the first admin user"
	@echo ""
	@echo "Develop (no docker — needs local Postgres, or 'make infra' for one):"
	@echo "  make dev            start backend (:8000) + frontend (:5173), hot reload"
	@echo "  make app            same, via scripts/start_app.sh (works on Claude web too)"
	@echo "  make app-stop       stop what start_app.sh started"
	@echo ""
	@echo "Docker:"
	@echo "  make up             full stack: postgres + adminer + backend serving the built SPA"
	@echo "  make down           stop it"
	@echo "  make infra          just postgres (for 'make dev')"
	@echo "  make infra-reset    wipe the database volume and start fresh"
	@echo "  make logs           follow container logs"
	@echo ""
	@echo "Database:"
	@echo "  make migrate        alembic upgrade head"
	@echo "  make migration m=\"add wombats\"   autogenerate a migration"
	@echo "  make db-shell       psql into the dev database"
	@echo ""
	@echo "Quality:"
	@echo "  make checks         the commit gate: ruff + mypy + tsc + vitest (silent = pass)"
	@echo "  make test           backend pytest + frontend vitest"
	@echo "  make format         ruff format + fixes"

install:
	$(UV) sync
	cd frontend && npm install

env:
	cp -n .env.example .env || true

seed:
	$(UV) run manage create --email "$(email)" --name "$(name)" --role admin

dev:
	bash scripts/start_app.sh

app:
	bash scripts/start_app.sh

app-stop:
	bash scripts/stop_app.sh

up:
	$(COMPOSE) up --build -d --wait
	@echo "backend+SPA: http://localhost:8000  adminer: http://localhost:8080"

down:
	$(COMPOSE) down

infra:
	$(COMPOSE) up -d --wait postgres

infra-reset:
	$(COMPOSE) down -v
	$(MAKE) infra migrate

logs:
	$(COMPOSE) logs -f

migrate:
	$(UV) run alembic upgrade head

migration:
	$(UV) run alembic revision --autogenerate -m "$(m)"

db-shell:
	$(COMPOSE) exec postgres psql -U piggy_user -d piggy

checks:
	bash scripts/checks.sh

test:
	$(UV) run pytest
	cd frontend && npm test

format:
	$(UV) run ruff format
	$(UV) run ruff check --fix
