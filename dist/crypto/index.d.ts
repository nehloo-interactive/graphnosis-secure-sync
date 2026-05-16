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
//# sourceMappingURL=index.d.ts.map