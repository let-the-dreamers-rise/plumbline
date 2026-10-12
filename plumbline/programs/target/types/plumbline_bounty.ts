/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/plumbline_bounty.json`.
 */
export type PlumblineBounty = {
  "address": "9mDieYQNR2L9xgaqS6LK26kxR26rA4R9UcFntG369RPf",
  "metadata": {
    "name": "plumblineBounty",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Plumbline pay-on-proof: escrowed reward paid to the payout bound in a verified sealed-eval score"
  },
  "instructions": [
    {
      "name": "claim",
      "docs": [
        "Permissionless: anyone may crank it; the money can only go to the payout proven in the score."
      ],
      "discriminator": [
        62,
        198,
        214,
        193,
        213,
        159,
        108,
        210
      ],
      "accounts": [
        {
          "name": "bounty",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  117,
                  110,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "bounty.sponsor",
                "account": "bounty"
              },
              {
                "kind": "account",
                "path": "bounty.suite_commitment",
                "account": "bounty"
              },
              {
                "kind": "account",
                "path": "bounty.nonce",
                "account": "bounty"
              }
            ]
          }
        },
        {
          "name": "verifiedScore"
        },
        {
          "name": "payout",
          "writable": true
        },
        {
          "name": "cranker",
          "docs": [
            "Whoever submits the claim; receives nothing."
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "createBounty",
      "docs": [
        "Escrow `amount` lamports for the first verified score on `suite_commitment` that reaches",
        "`min_correct / min_total` and was recorded at or before `deadline_slot`.",
        "`claim_grace_slots`: after the deadline the sponsor must wait this long before refunding, so a",
        "score recorded just before the deadline can still be claimed.",
        "`mint`: reserved for SPL (USDC); only `None` (lamports) is supported now.",
        "`require_registered_suite`: `suite` must be the registry's Suite PDA for this commitment.",
        "`required_compose_hash` / `required_image_id`: all zero = accept whatever the registry config",
        "accepted; non-zero = also pin the enclave compose / guest image, so a later registry config",
        "rotation cannot change what this bounty pays for."
      ],
      "discriminator": [
        122,
        90,
        14,
        143,
        8,
        125,
        200,
        2
      ],
      "accounts": [
        {
          "name": "bounty",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  117,
                  110,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "sponsor"
              },
              {
                "kind": "arg",
                "path": "suiteCommitment"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "sponsor",
          "writable": true,
          "signer": true
        },
        {
          "name": "suite",
          "optional": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "suiteCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "minCorrect",
          "type": "u32"
        },
        {
          "name": "minTotal",
          "type": "u32"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "deadlineSlot",
          "type": "u64"
        },
        {
          "name": "claimGraceSlots",
          "type": "u64"
        },
        {
          "name": "mint",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "requireRegisteredSuite",
          "type": "bool"
        },
        {
          "name": "requiredComposeHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "requiredImageId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "refund",
      "docs": [
        "Sponsor only, once `deadline_slot + claim_grace_slots` has passed and nothing was paid.",
        "Closes the bounty: escrow plus rent go back to the sponsor."
      ],
      "discriminator": [
        2,
        96,
        183,
        251,
        63,
        208,
        46,
        46
      ],
      "accounts": [
        {
          "name": "bounty",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  117,
                  110,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "bounty.sponsor",
                "account": "bounty"
              },
              {
                "kind": "account",
                "path": "bounty.suite_commitment",
                "account": "bounty"
              },
              {
                "kind": "account",
                "path": "bounty.nonce",
                "account": "bounty"
              }
            ]
          }
        },
        {
          "name": "sponsor",
          "writable": true,
          "signer": true,
          "relations": [
            "bounty"
          ]
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "bounty",
      "discriminator": [
        237,
        16,
        105,
        198,
        19,
        69,
        242,
        234
      ]
    }
  ],
  "events": [
    {
      "name": "bountyClaimed",
      "discriminator": [
        140,
        202,
        21,
        51,
        211,
        65,
        142,
        21
      ]
    },
    {
      "name": "bountyCreated",
      "discriminator": [
        68,
        252,
        247,
        196,
        154,
        247,
        130,
        49
      ]
    },
    {
      "name": "bountyRefunded",
      "discriminator": [
        158,
        18,
        109,
        41,
        239,
        13,
        79,
        43
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "zeroHash",
      "msg": "hash fields must not be all zero"
    },
    {
      "code": 6001,
      "name": "badTarget",
      "msg": "target must have min_total > 0 and min_correct <= min_total"
    },
    {
      "code": 6002,
      "name": "zeroAmount",
      "msg": "amount must be > 0"
    },
    {
      "code": 6003,
      "name": "mintNotSupported",
      "msg": "only lamport bounties are supported (mint must be None)"
    },
    {
      "code": 6004,
      "name": "deadlineInPast",
      "msg": "deadline_slot must be in the future (and deadline + grace must not overflow)"
    },
    {
      "code": 6005,
      "name": "suiteNotRegistered",
      "msg": "bounty requires the suite to be registered in the sealed-eval registry"
    },
    {
      "code": 6006,
      "name": "badPayout",
      "msg": "payout account must be the payout proven in the score"
    },
    {
      "code": 6007,
      "name": "alreadyPaid",
      "msg": "bounty is already paid"
    },
    {
      "code": 6008,
      "name": "scoreNotFromRegistry",
      "msg": "score account is not owned by the sealed-eval registry"
    },
    {
      "code": 6009,
      "name": "notAVerifiedScore",
      "msg": "account is not a registry VerifiedScore"
    },
    {
      "code": 6010,
      "name": "badScorePda",
      "msg": "score account is not the registry PDA [verified, statement_hash]"
    },
    {
      "code": 6011,
      "name": "wrongSuite",
      "msg": "score is for a different suite"
    },
    {
      "code": 6012,
      "name": "wrongEnclave",
      "msg": "score came from a different enclave compose / guest image than the bounty pins"
    },
    {
      "code": 6013,
      "name": "belowTarget",
      "msg": "score is below the bounty target"
    },
    {
      "code": 6014,
      "name": "scoreAfterDeadline",
      "msg": "score was recorded after the bounty deadline"
    },
    {
      "code": 6015,
      "name": "scoreBeforeBounty",
      "msg": "score was recorded before the bounty was created"
    },
    {
      "code": 6016,
      "name": "noPayout",
      "msg": "score carries no payout address (statement without payout)"
    },
    {
      "code": 6017,
      "name": "refundTooEarly",
      "msg": "refund only after deadline_slot + claim_grace_slots"
    },
    {
      "code": 6018,
      "name": "notSponsor",
      "msg": "only the sponsor can refund"
    }
  ],
  "types": [
    {
      "name": "bounty",
      "docs": [
        "Terms and lamport vault in one PDA: lamports = rent + amount while open."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sponsor",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "suiteCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "minCorrect",
            "type": "u32"
          },
          {
            "name": "minTotal",
            "type": "u32"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "mint",
            "docs": [
              "None = lamports. Some(mint) reserved for SPL (USDC), rejected for now."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "deadlineSlot",
            "type": "u64"
          },
          {
            "name": "claimGraceSlots",
            "type": "u64"
          },
          {
            "name": "requireRegisteredSuite",
            "type": "bool"
          },
          {
            "name": "requiredComposeHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "requiredImageId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "createdSlot",
            "type": "u64"
          },
          {
            "name": "status",
            "docs": [
              "0 = open, 1 = paid. (Refunded bounties are closed.)"
            ],
            "type": "u8"
          },
          {
            "name": "winnerStatementHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "winnerModelIdHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "winnerPayout",
            "type": "pubkey"
          },
          {
            "name": "paidSlot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "bountyClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bounty",
            "type": "pubkey"
          },
          {
            "name": "statementHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "modelIdHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "correct",
            "type": "u32"
          },
          {
            "name": "total",
            "type": "u32"
          },
          {
            "name": "scoreSlot",
            "type": "u64"
          },
          {
            "name": "payout",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "cranker",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bountyCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bounty",
            "type": "pubkey"
          },
          {
            "name": "sponsor",
            "type": "pubkey"
          },
          {
            "name": "suiteCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "minCorrect",
            "type": "u32"
          },
          {
            "name": "minTotal",
            "type": "u32"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "mint",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "deadlineSlot",
            "type": "u64"
          },
          {
            "name": "claimGraceSlots",
            "type": "u64"
          },
          {
            "name": "requireRegisteredSuite",
            "type": "bool"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bountyRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bounty",
            "type": "pubkey"
          },
          {
            "name": "sponsor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "returnedLamports",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
