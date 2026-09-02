# Component test app

A simple consumer of the library in this repo. It uses the workspace build
rather than the published package to exercise the working tree.

It was designed to contrast with the TODO demo in
[keyhive-todo-app-demo](https://github.com/inkandswitch/keyhive-todo-app-demo):

|                   | TODO demo                  | This app                                       |
| ----------------- | -------------------------- | ---------------------------------------------- |
| Name directory    | shared Automerge phonebook | localStorage, per browser                      |
| Directory updates | new object each change     | `subscribe` callbacks                          |
| Styling           | its own Tailwind setup     | `@inkandswitch/onomancy-react/styles.css` only |
| Theme             | dark                       | light                                          |
| Component context | dialogs                    | inline sections                                |

## Run

```
pnpm install
pnpm app          # from the repo root
```

It opens at http://localhost:5558 and builds the library first. There is no
configuration and no phonebook id to supply.

## Trying the access components

Granting access needs a second identity which can be provided by a second browser
profile. Open the app there, copy its contact card from the account section,
and paste it into the "Contact Card" field here.
