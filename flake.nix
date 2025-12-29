{
  description = "Mysti - AI Coding Agent VSCode Extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Node.js and tools
            nodejs_20
            nodePackages.npm
            nodePackages.typescript

            # Linting
            nodePackages.eslint
``
            # Packaging (use npx vsce if vsce is not available)
            vsce
          ];

          shellHook = ''
            echo "Mysti Development Environment"
            echo "=================================="
            echo ""
            echo "Available commands:"
            echo "  npm run compile          - Production build"
            echo "  npm run watch            - Development build with watch mode"
            echo "  npm run lint             - ESLint check"
            echo "  npm run sync-agents      - Sync agent definitions"
            echo "  npx vsce package         - Package as .vsix"
            echo ""
            echo "Press F5 in VSCode to launch Extension Development Host"
            echo ""

            # Set up Node environment
            export NODE_ENV=development

            # Ensure npm dependencies are installed
            if [ ! -d "node_modules" ]; then
              echo "Installing npm dependencies..."
              npm install
            fi
          '';
        };
      }
    );
}
