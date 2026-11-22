import { describe, expect, it } from "vitest";
import { isValidSignature, sign, verifySubscription } from "@/lib/whatsapp/signature";
import { fixtureRaw } from "./helpers/fixtures";

const SECRET = "test_app_secret";

describe("X-Hub-Signature-256", () => {
  const body = fixtureRaw("text");

  it("acepta una firma correcta del cuerpo exacto", () => {
    expect(isValidSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });
  it("rechaza si falta la cabecera", () => {
    expect(isValidSignature(body, null, SECRET)).toBe(false);
    expect(isValidSignature(body, "", SECRET)).toBe(false);
  });
  it("rechaza un cuerpo modificado (aunque sea un espacio)", () => {
    expect(isValidSignature(body + " ", sign(body, SECRET), SECRET)).toBe(false);
  });
  it("rechaza el JSON re-serializado (hay que firmar el cuerpo en crudo)", () => {
    const reserialized = JSON.stringify(JSON.parse(body));
    expect(reserialized).not.toBe(body);
    expect(isValidSignature(reserialized, sign(body, SECRET), SECRET)).toBe(false);
  });
  it("rechaza otro secreto, otro algoritmo o formato inválido", () => {
    expect(isValidSignature(body, sign(body, "otro"), SECRET)).toBe(false);
    expect(isValidSignature(body, sign(body, SECRET).replace("sha256", "sha1"), SECRET)).toBe(false);
    expect(isValidSignature(body, "sha256=zz", SECRET)).toBe(false);
  });
});

describe("verificación GET del webhook", () => {
  const p = (o: Record<string, string>) => new URLSearchParams(o);
  it("devuelve el challenge con el token correcto", () => {
    expect(verifySubscription(p({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "1158201444" }), "tok")).toBe("1158201444");
  });
  it("rechaza token incorrecto, modo incorrecto o sin challenge", () => {
    expect(verifySubscription(p({ "hub.mode": "subscribe", "hub.verify_token": "mal", "hub.challenge": "1" }), "tok")).toBeNull();
    expect(verifySubscription(p({ "hub.mode": "unsubscribe", "hub.verify_token": "tok", "hub.challenge": "1" }), "tok")).toBeNull();
    expect(verifySubscription(p({ "hub.mode": "subscribe", "hub.verify_token": "tok" }), "tok")).toBeNull();
  });
});
