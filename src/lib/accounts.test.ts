import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forgetAccount, rememberAccount, rememberedAccounts, sameAccounts } from "./accounts.ts";

describe("rememberAccount", () => {
  it("keeps each signed-in handle once and moves the latest switch to the end", () => {
    const first = rememberAccount([], "current_user");
    assert.deepEqual(first, { accounts: ["current_user"], added: true });

    const again = rememberAccount(first.accounts, "Current_User");
    assert.deepEqual(again, { accounts: ["Current_User"], added: false });

    const switched = rememberAccount(again.accounts, "other_user");
    assert.deepEqual(switched, { accounts: ["Current_User", "other_user"], added: true });

    const back = rememberAccount(switched.accounts, "current_user");
    assert.deepEqual(back, { accounts: ["other_user", "current_user"], added: false });
  });

  it("drops handles that are not an X username", () => {
    assert.deepEqual(rememberAccount(["ok", "has space", ""], "bad-name"), {
      accounts: ["ok"],
      added: false,
    });
    assert.deepEqual(rememberedAccounts(["ok", "ok", 1, "other"]), ["ok", "other"]);
  });
});

describe("forgetAccount", () => {
  it("removes one handle without touching the others", () => {
    assert.deepEqual(forgetAccount(["current_user", "other_user"], "Current_User"), ["other_user"]);
    assert.deepEqual(forgetAccount(["current_user"], "missing"), ["current_user"]);
  });
});

describe("sameAccounts", () => {
  it("matches the same handles regardless of order and casing", () => {
    assert.equal(sameAccounts(["Ada", "bob"], ["bob", "ada"]), true);
    assert.equal(sameAccounts(["ada"], ["ada", "bob"]), false);
  });
});
