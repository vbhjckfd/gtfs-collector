.PHONY: install deploy

install:
	. "$$NVM_DIR/nvm.sh" && nvm use && npm install

deploy:
	. "$$NVM_DIR/nvm.sh" && nvm use && npx wrangler deploy
