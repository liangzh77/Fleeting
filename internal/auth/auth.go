// Package auth implements the password, token and digest primitives used by
// the single-user login flow.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"github.com/liangzh77/fleeting/internal/textutil"
	"golang.org/x/crypto/scrypt"
)

const (
	scryptN      = 16384
	scryptR      = 8
	scryptP      = 1
	scryptKeyLen = 64
)

var hashPattern = regexp.MustCompile(`^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$`)

// HashPassword creates scrypt:<salt>:<key>. The salt is the textual hex string,
// exactly as the Node implementation passed it to crypto.scrypt.
func HashPassword(password string) (string, error) {
	if textutil.Len(password) == 0 || textutil.Len(password) > 1024 {
		return "", errors.New("密码不能为空，且不能超过 1024 个字符")
	}
	saltBytes := make([]byte, 16)
	if _, err := rand.Read(saltBytes); err != nil {
		return "", err
	}
	salt := hex.EncodeToString(saltBytes)
	key, err := scrypt.Key([]byte(password), []byte(salt), scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return "", err
	}
	return "scrypt:" + salt + ":" + hex.EncodeToString(key), nil
}

// ValidHash reports whether hash has the shape produced by HashPassword.
func ValidHash(hash string) bool {
	return hashPattern.MatchString(hash)
}

// VerifyPassword checks a plaintext password against a stored hash.
func VerifyPassword(password, hash string) bool {
	if !ValidHash(hash) || textutil.Len(password) == 0 || textutil.Len(password) > 1024 {
		return false
	}
	parts := strings.SplitN(hash, ":", 3)
	if len(parts) != 3 {
		return false
	}
	expected, err := hex.DecodeString(parts[2])
	if err != nil || len(expected) != scryptKeyLen {
		return false
	}
	key, err := scrypt.Key([]byte(password), []byte(parts[1]), scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(key, expected) == 1
}

// Digest is the SHA-256 hex digest used for session tokens and request bodies.
func Digest(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// Token returns 32 random bytes as 64 hex characters.
func Token() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// NewUUID returns a random RFC 4122 version-4 UUID, matching crypto.randomUUID().
func NewUUID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(buf)
	return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:32], nil
}
