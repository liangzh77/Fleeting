package auth

import (
	"testing"
)

// Produced by Node 24 crypto.scryptSync("parity-password", salt, 64), which is
// the exact format the production database already contains.
const nodeHash = "scrypt:3a92567980fbee287f6a640ecaca7747:09ae64e95bede4c14030079d51d4239472837917d8d653a921c099beff23468b923236f6843a6b21eff9d93d3824674249dc35c9ae7ab85238ba429505316391"

func TestNodeScryptHashCompatibility(t *testing.T) {
	if !ValidHash(nodeHash) {
		t.Fatal("node hash should be valid")
	}
	if !VerifyPassword("parity-password", nodeHash) {
		t.Fatal("Go must verify the existing Node scrypt hash")
	}
	if VerifyPassword("wrong", nodeHash) {
		t.Fatal("wrong password accepted")
	}
	if VerifyPassword("parity-password", "scrypt:bad") {
		t.Fatal("invalid hash accepted")
	}
}

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("短密码")
	if err != nil {
		t.Fatal(err)
	}
	if !ValidHash(hash) {
		t.Fatalf("invalid hash shape: %s", hash)
	}
	if !VerifyPassword("短密码", hash) {
		t.Fatal("round trip failed")
	}
	if _, err := HashPassword(""); err == nil {
		t.Fatal("empty password must be rejected")
	}
}

func TestDigestMatchesSHA256(t *testing.T) {
	if got := Digest("abc"); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("unexpected digest: %s", got)
	}
}

func TestTokensAndUUIDs(t *testing.T) {
	token, err := Token()
	if err != nil || len(token) != 64 {
		t.Fatalf("token: %q %v", token, err)
	}
	id, err := NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 36 || id[14] != '4' || (id[19] != '8' && id[19] != '9' && id[19] != 'a' && id[19] != 'b') {
		t.Fatalf("unexpected uuid: %s", id)
	}
}
