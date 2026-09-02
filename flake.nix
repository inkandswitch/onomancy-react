{
  description = "onomancy-react";

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-26.05";
    nixos-unstable.url = "nixpkgs/nixos-unstable-small";

    command-utils.url = "git+https://tangled.org/expede.wtf/nix-command-utils";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    command-utils,
    flake-utils,
    nixos-unstable,
    nixpkgs,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {inherit system;};
        unstable = import nixos-unstable {inherit system;};

        nodejs = pkgs.nodejs_22;

        # Pinned to pnpm 10 to match `packageManager` in package.json;
        # pnpm 11 stopped reading `pnpm.overrides` from package.json and
        # treats ignored build scripts as a hard error.
        pnpm = pkgs.pnpm_10;

        # The driver version must match `@playwright/test` in package.json,
        # otherwise the browser revisions in PLAYWRIGHT_BROWSERS_PATH won't
        # resolve.
        playwright = unstable.playwright-driver;

        format-pkgs = with pkgs; [
          alejandra
          nixpkgs-fmt
        ];

        js-env = [nodejs pnpm];

        mkCheck = name: text:
          pkgs.writeShellApplication {
            name = "onomancy-react-${name}";
            runtimeInputs = js-env;
            text = ''
              set -x
              ${text}
            '';
          };

        # Mirrors .github/workflows/ci.yml; each check assumes
        # `pnpm install --frozen-lockfile` has already run (the `ci`
        # aggregate does it for you).
        ci-checks = {
          ci-lint = mkCheck "ci-lint" ''
            pnpm run lint
          '';

          ci-tsc = mkCheck "ci-tsc" ''
            pnpm run tsc
            pnpm run tsc:e2e
          '';

          # Also runs check:isolation and check:prefix: the built output
          # imports nothing but React, and every Tailwind class is prefixed
          # so it cannot collide with the host application's styles.
          ci-build = mkCheck "ci-build" ''
            pnpm run build
          '';

          # Fails if the published tarball would be missing an entry point.
          ci-pack = mkCheck "ci-pack" ''
            npm pack --dry-run
          '';

          # A consumer compiled against the build above.
          ci-app = mkCheck "ci-app" ''
            pnpm run app:build
          '';
        };

        ci-all = pkgs.writeShellApplication {
          name = "onomancy-react-ci";
          runtimeInputs = js-env ++ pkgs.lib.attrValues ci-checks;
          text = ''
            pnpm install --frozen-lockfile
            ${pkgs.lib.concatMapStringsSep "\n"
              (check: "onomancy-react-${check}")
              (builtins.attrNames ci-checks)}
          '';
        };

        # Playwright tests driving the component test app: two browser
        # contexts are two keyhive identities. Not in the `ci` aggregate:
        # pulls whole browsers — run deliberately.
        ci-e2e = pkgs.writeShellApplication {
          name = "onomancy-react-ci-e2e";
          runtimeInputs = js-env;
          text = ''
            export PLAYWRIGHT_BROWSERS_PATH="${playwright.browsers}"
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
            pnpm run test:e2e "$@"
          '';
        };

        cmd = command-utils.cmd.${system};
        pnpm' = command-utils.pnpm.${system};

        command_menu = command-utils.commands.${system} [
          (pnpm'.build {pnpm = "${pnpm}/bin/pnpm";})
          (pnpm'.install {pnpm = "${pnpm}/bin/pnpm";})

          (command-utils.asModule.${system} {
            "lint" = cmd "ESLint + Prettier check" ''
              exec ${pnpm}/bin/pnpm run lint
            '';

            "lint:fix" = cmd "Apply ESLint + Prettier fixes" ''
              exec ${pnpm}/bin/pnpm run lint:fix
            '';

            "app:dev" = cmd "Run the component test app dev server" ''
              exec ${pnpm}/bin/pnpm run app
            '';

            "test:e2e" = cmd "Playwright tests against the test app (extra args pass through)" ''
              exec ${ci-e2e}/bin/onomancy-react-ci-e2e "$@"
            '';

            "test:e2e:ui" = cmd "Playwright tests in UI mode" ''
              export PLAYWRIGHT_BROWSERS_PATH="${playwright.browsers}"
              export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
              exec ${pnpm}/bin/pnpm run test:e2e:ui
            '';

            "ci" = cmd "Run all cheap CI checks (lint, tsc, build, pack, app)" ''
              exec ${ci-all}/bin/onomancy-react-ci
            '';
          })
        ];
      in {
        devShells.default = pkgs.mkShell {
          name = "onomancy-react_shell";

          nativeBuildInputs =
            command_menu
            ++ js-env
            ++ [
              pkgs.typescript
              pkgs.typescript-language-server
            ]
            ++ format-pkgs;

          PLAYWRIGHT_BROWSERS_PATH = "${playwright.browsers}";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";

          shellHook = ''
            unset SOURCE_DATE_EPOCH
            export WORKSPACE_ROOT="$(pwd)"
            menu
          '';
        };

        apps =
          pkgs.lib.mapAttrs (name: check: {
            type = "app";
            program = "${check}/bin/onomancy-react-${name}";
          })
          (ci-checks
            // {
              ci = ci-all;
              ci-e2e = ci-e2e;
            });

        formatter = pkgs.alejandra;
      }
    );
}
