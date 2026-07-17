#!/bin/bash
set -e

echo "Updating apt and installing dependencies..."
sudo apt-get update
sudo apt-get install -y ripgrep fd-find build-essential stow

echo "Detecting architecture for Neovim..."
ARCH=$(dpkg --print-architecture)
if [ "$ARCH" = "arm64" ]; then
    NVIM_ARCH="arm64"
else
    NVIM_ARCH="x86_64"
fi

echo "Downloading Neovim for $NVIM_ARCH..."
curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux-$NVIM_ARCH.tar.gz

echo "Installing Neovim..."
sudo tar -C /opt -xzf nvim-linux-$NVIM_ARCH.tar.gz
sudo ln -sf /opt/nvim-linux-$NVIM_ARCH/bin/nvim /usr/local/bin/nvim
rm nvim-linux-$NVIM_ARCH.tar.gz

echo "Installing NPM dependencies..."
npm install

echo "Installing Antigravity CLI..."
curl -fsSL https://antigravity.google/cli/install.sh | bash

echo "Applying dotfiles via stow..."
if [ -d "$HOME/dotfiles" ]; then
    cd "$HOME/dotfiles"
    stow ./*
    cd -
else
    echo "Dotfiles directory not found. Skipping stow."
fi

echo "Symlinking global skills for Antigravity..."
mkdir -p ~/.gemini
ln -sfn ~/.agents/skills ~/.gemini/skills

echo "Done!"
