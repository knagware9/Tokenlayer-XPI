// Package main implements the TokenLayer compliance-asset chaincode for
// Hyperledger Fabric. It mirrors the rules of the EVM ComplianceToken /
// ComplianceNFT contracts and the off-chain SimulatedLedger: an operator-
// mediated, compliance-aware asset supporting both fungible (amount) and
// non-fungible (token-id) tokens with an allowlist and per-account freeze.
//
// Build/deploy: see infra/fabric/README.md. Requires fabric-contract-api-go.
package main

import (
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// SmartContract provides the TokenLayer asset operations.
type SmartContract struct {
	contractapi.Contract
}

type asset struct {
	TokenType        string `json:"tokenType"`
	AllowlistEnabled bool   `json:"allowlistEnabled"`
}

// --- key helpers ---

func assetKey(ref string) string            { return "asset:" + ref }
func balKey(ref, acct string) string        { return "bal:" + ref + ":" + acct }
func supplyKey(ref string) string           { return "supply:" + ref }
func frozenKey(ref, acct string) string     { return "frozen:" + ref + ":" + acct }
func allowedKey(ref, acct string) string    { return "allowed:" + ref + ":" + acct }
func ownerKey(ref, tokenID string) string   { return "owner:" + ref + ":" + tokenID }
func ownedKey(ref, acct string) string      { return "owned:" + ref + ":" + acct }

func (s *SmartContract) loadAsset(ctx contractapi.TransactionContextInterface, ref string) (*asset, error) {
	data, err := ctx.GetStub().GetState(assetKey(ref))
	if err != nil || data == nil {
		return nil, fmt.Errorf("unknown asset %s", ref)
	}
	var a asset
	if err := json.Unmarshal(data, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *SmartContract) flag(ctx contractapi.TransactionContextInterface, key string) (bool, error) {
	v, err := ctx.GetStub().GetState(key)
	return v != nil && string(v) == "1", err
}

func (s *SmartContract) bigState(ctx contractapi.TransactionContextInterface, key string) (*big.Int, error) {
	v, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, err
	}
	n := new(big.Int)
	if v != nil {
		n.SetString(string(v), 10)
	}
	return n, nil
}

// --- lifecycle ---

func (s *SmartContract) DeployAsset(ctx contractapi.TransactionContextInterface, ref, tokenType string, allowlistEnabled bool) error {
	a := asset{TokenType: tokenType, AllowlistEnabled: allowlistEnabled}
	data, _ := json.Marshal(a)
	return ctx.GetStub().PutState(assetKey(ref), data)
}

func (s *SmartContract) Mint(ctx contractapi.TransactionContextInterface, ref, to, amount string) error {
	a, err := s.loadAsset(ctx, ref)
	if err != nil {
		return err
	}
	if err := s.requireAllowed(ctx, a, ref, to); err != nil {
		return err
	}
	if frozen, _ := s.flag(ctx, frozenKey(ref, to)); frozen {
		return fmt.Errorf("account %s is frozen", to)
	}
	amt, ok := new(big.Int).SetString(amount, 10)
	if !ok || amt.Sign() <= 0 {
		return fmt.Errorf("invalid amount")
	}
	bal, _ := s.bigState(ctx, balKey(ref, to))
	supply, _ := s.bigState(ctx, supplyKey(ref))
	_ = ctx.GetStub().PutState(balKey(ref, to), []byte(bal.Add(bal, amt).String()))
	return ctx.GetStub().PutState(supplyKey(ref), []byte(supply.Add(supply, amt).String()))
}

func (s *SmartContract) Transfer(ctx contractapi.TransactionContextInterface, ref, from, to, amount string) error {
	a, err := s.loadAsset(ctx, ref)
	if err != nil {
		return err
	}
	for _, acct := range []string{from, to} {
		if frozen, _ := s.flag(ctx, frozenKey(ref, acct)); frozen {
			return fmt.Errorf("account %s is frozen", acct)
		}
		if err := s.requireAllowed(ctx, a, ref, acct); err != nil {
			return err
		}
	}
	amt, ok := new(big.Int).SetString(amount, 10)
	if !ok || amt.Sign() <= 0 {
		return fmt.Errorf("invalid amount")
	}
	fromBal, _ := s.bigState(ctx, balKey(ref, from))
	if fromBal.Cmp(amt) < 0 {
		return fmt.Errorf("insufficient balance")
	}
	toBal, _ := s.bigState(ctx, balKey(ref, to))
	_ = ctx.GetStub().PutState(balKey(ref, from), []byte(fromBal.Sub(fromBal, amt).String()))
	return ctx.GetStub().PutState(balKey(ref, to), []byte(toBal.Add(toBal, amt).String()))
}

func (s *SmartContract) Burn(ctx contractapi.TransactionContextInterface, ref, from, amount string) error {
	if _, err := s.loadAsset(ctx, ref); err != nil {
		return err
	}
	amt, ok := new(big.Int).SetString(amount, 10)
	if !ok || amt.Sign() <= 0 {
		return fmt.Errorf("invalid amount")
	}
	bal, _ := s.bigState(ctx, balKey(ref, from))
	if bal.Cmp(amt) < 0 {
		return fmt.Errorf("insufficient balance")
	}
	supply, _ := s.bigState(ctx, supplyKey(ref))
	_ = ctx.GetStub().PutState(balKey(ref, from), []byte(bal.Sub(bal, amt).String()))
	return ctx.GetStub().PutState(supplyKey(ref), []byte(supply.Sub(supply, amt).String()))
}

// --- non-fungible ---

func (s *SmartContract) MintToken(ctx contractapi.TransactionContextInterface, ref, to, tokenID, uri string) error {
	a, err := s.loadAsset(ctx, ref)
	if err != nil {
		return err
	}
	if existing, _ := ctx.GetStub().GetState(ownerKey(ref, tokenID)); existing != nil {
		return fmt.Errorf("token %s exists", tokenID)
	}
	if err := s.requireAllowed(ctx, a, ref, to); err != nil {
		return err
	}
	if frozen, _ := s.flag(ctx, frozenKey(ref, to)); frozen {
		return fmt.Errorf("account %s is frozen", to)
	}
	_ = ctx.GetStub().PutState(ownerKey(ref, tokenID), []byte(to))
	return s.addOwned(ctx, ref, to, tokenID)
}

func (s *SmartContract) TransferToken(ctx contractapi.TransactionContextInterface, ref, from, to, tokenID string) error {
	a, err := s.loadAsset(ctx, ref)
	if err != nil {
		return err
	}
	owner, _ := ctx.GetStub().GetState(ownerKey(ref, tokenID))
	if owner == nil || string(owner) != from {
		return fmt.Errorf("%s does not own %s", from, tokenID)
	}
	for _, acct := range []string{from, to} {
		if frozen, _ := s.flag(ctx, frozenKey(ref, acct)); frozen {
			return fmt.Errorf("account %s is frozen", acct)
		}
		if err := s.requireAllowed(ctx, a, ref, acct); err != nil {
			return err
		}
	}
	_ = s.removeOwned(ctx, ref, from, tokenID)
	_ = ctx.GetStub().PutState(ownerKey(ref, tokenID), []byte(to))
	return s.addOwned(ctx, ref, to, tokenID)
}

func (s *SmartContract) BurnToken(ctx contractapi.TransactionContextInterface, ref, tokenID string) error {
	owner, _ := ctx.GetStub().GetState(ownerKey(ref, tokenID))
	if owner == nil {
		return fmt.Errorf("no such token %s", tokenID)
	}
	_ = s.removeOwned(ctx, ref, string(owner), tokenID)
	return ctx.GetStub().DelState(ownerKey(ref, tokenID))
}

func (s *SmartContract) ownedList(ctx contractapi.TransactionContextInterface, ref, acct string) []string {
	v, _ := ctx.GetStub().GetState(ownedKey(ref, acct))
	ids := []string{}
	if v != nil {
		_ = json.Unmarshal(v, &ids)
	}
	return ids
}

func (s *SmartContract) addOwned(ctx contractapi.TransactionContextInterface, ref, acct, tokenID string) error {
	ids := append(s.ownedList(ctx, ref, acct), tokenID)
	data, _ := json.Marshal(ids)
	return ctx.GetStub().PutState(ownedKey(ref, acct), data)
}

func (s *SmartContract) removeOwned(ctx contractapi.TransactionContextInterface, ref, acct, tokenID string) error {
	ids := s.ownedList(ctx, ref, acct)
	out := ids[:0]
	for _, id := range ids {
		if id != tokenID {
			out = append(out, id)
		}
	}
	data, _ := json.Marshal(out)
	return ctx.GetStub().PutState(ownedKey(ref, acct), data)
}

// --- compliance ---

func (s *SmartContract) requireAllowed(ctx contractapi.TransactionContextInterface, a *asset, ref, acct string) error {
	if !a.AllowlistEnabled {
		return nil
	}
	if allowed, _ := s.flag(ctx, allowedKey(ref, acct)); !allowed {
		return fmt.Errorf("account %s not allowlisted", acct)
	}
	return nil
}

func (s *SmartContract) SetFrozen(ctx contractapi.TransactionContextInterface, ref, acct string, frozen bool) error {
	return s.setFlag(ctx, frozenKey(ref, acct), frozen)
}

func (s *SmartContract) SetAllowed(ctx contractapi.TransactionContextInterface, ref, acct string, allowed bool) error {
	return s.setFlag(ctx, allowedKey(ref, acct), allowed)
}

func (s *SmartContract) setFlag(ctx contractapi.TransactionContextInterface, key string, on bool) error {
	if on {
		return ctx.GetStub().PutState(key, []byte("1"))
	}
	return ctx.GetStub().DelState(key)
}

// --- reads ---

func (s *SmartContract) BalanceOf(ctx contractapi.TransactionContextInterface, ref, acct string) (string, error) {
	a, err := s.loadAsset(ctx, ref)
	if err != nil {
		return "", err
	}
	if a.TokenType == "nonfungible" {
		return fmt.Sprintf("%d", len(s.ownedList(ctx, ref, acct))), nil
	}
	bal, _ := s.bigState(ctx, balKey(ref, acct))
	return bal.String(), nil
}

func (s *SmartContract) TotalSupply(ctx contractapi.TransactionContextInterface, ref string) (string, error) {
	supply, _ := s.bigState(ctx, supplyKey(ref))
	return supply.String(), nil
}

func (s *SmartContract) OwnerOf(ctx contractapi.TransactionContextInterface, ref, tokenID string) (string, error) {
	owner, _ := ctx.GetStub().GetState(ownerKey(ref, tokenID))
	return string(owner), nil
}

func (s *SmartContract) TokensOf(ctx contractapi.TransactionContextInterface, ref, acct string) (string, error) {
	data, _ := json.Marshal(s.ownedList(ctx, ref, acct))
	return string(data), nil
}

func (s *SmartContract) IsFrozen(ctx contractapi.TransactionContextInterface, ref, acct string) (bool, error) {
	return s.flag(ctx, frozenKey(ref, acct))
}

func (s *SmartContract) IsAllowed(ctx contractapi.TransactionContextInterface, ref, acct string) (bool, error) {
	return s.flag(ctx, allowedKey(ref, acct))
}

func main() {
	cc, err := contractapi.NewChaincode(&SmartContract{})
	if err != nil {
		panic(err)
	}
	if err := cc.Start(); err != nil {
		panic(err)
	}
}
