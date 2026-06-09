export interface DerivedKey {
    key: Uint8Array;
    salt: Uint8Array;
    opslimit: number;
    memlimit: number;
}
export declare function deriveKey(passphrase: string, salt?: Uint8Array): Promise<DerivedKey>;
export declare function encrypt(plaintext: Uint8Array, key: Uint8Array, salt: Uint8Array): Promise<Uint8Array>;
export declare function decrypt(ciphertext: Uint8Array, passphraseOrKey: string | Uint8Array): Promise<Uint8Array>;
export declare function makeRecoveryWrap(dataKey: Uint8Array, recoveryPhrase: string): Promise<Uint8Array>;
export declare function unwrapRecovery(blob: Uint8Array, recoveryPhrase: string): Promise<Uint8Array>;
export interface SigningKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}
export declare function generateSigningKeyPair(): Promise<SigningKeyPair>;
/** Detached Ed25519 signature (64 bytes) over `message`. */
export declare function sign(message: Uint8Array, secretKey: Uint8Array): Promise<Uint8Array>;
/** Verify a detached Ed25519 signature. Returns false on any malformed input
 *  rather than throwing, so a bad chunk is a rejection, not a crash. */
export declare function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
export declare const SIGN_PUBLICKEYBYTES = 32;
export declare const SIGN_SECRETKEYBYTES = 64;
export declare const SIGN_BYTES = 64;
//# sourceMappingURL=index.d.ts.map