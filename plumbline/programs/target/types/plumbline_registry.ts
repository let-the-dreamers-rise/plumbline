/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/plumbline_registry.json`.
 */
export type PlumblineRegistry = {
  "address": "Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW",
  "metadata": {
    "name": "plumblineRegistry",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Plumbline registry: Groth16-verified sealed-eval scores with the entrant's payout"
  },
  "instructions": [
    {
      "name": "initConfig",
      "docs": [
        "One-time setup by the program's upgrade authority: which guest image is trusted, which root",
        "it must have pinned (INTEL_SGX_ROOT_SHA256 in production), which enclave app compose hash a",
        "score must come from, and optionally which TD image (mr_td; all zero = any)."
      ],
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "programData",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  203,
                  209,
                  95,
                  15,
                  172,
                  165,
                  248,
                  149,
                  149,
                  103,
                  51,
                  179,
                  55,
                  246,
                  155,
                  33,
                  116,
                  86,
                  2,
                  116,
                  197,
                  66,
                  161,
                  54,
                  188,
                  140,
                  31,
                  7,
                  195,
                  163,
                  21,
                  163
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                2,
                168,
                246,
                145,
                78,
                136,
                161,
                176,
                226,
                16,
                21,
                62,
                247,
                99,
                174,
                43,
                0,
                194,
                185,
                61,
                22,
                193,
                36,
                210,
                192,
                83,
                122,
                16,
                4,
                128,
                0,
                0
              ]
            }
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "imageId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "rootSha256",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "composeHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "mrTd",
          "type": {
            "array": [
              "u8",
              48
            ]
          }
        }
      ]
    },
    {
      "name": "recordScore",
      "docs": [
        "Record an attested score. Permissionless; fails if this statement hash is already recorded.",
        "Pass the suite's PDA as `suite` when the suite is registered: its commitment must match and",
        "its score count goes up. Omit it for unregistered suites."
      ],
      "discriminator": [
        30,
        181,
        94,
        137,
        7,
        160,
        236,
        158
      ],
      "accounts": [
        {
          "name": "score",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  99,
                  111,
                  114,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "statementHash"
              }
            ]
          }
        },
        {
          "name": "suite",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  105,
                  116,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "suiteCommitment"
              }
            ]
          }
        },
        {
          "name": "submitter",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
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
          "name": "suiteCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "quoteHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "mrTd",
          "type": {
            "array": [
              "u8",
              48
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
          "name": "bindingVersion",
          "type": "u8"
        }
      ]
    },
    {
      "name": "recordVerifiedScore",
      "docs": [
        "Record a score backed by a Groth16 proof of the sealed-eval guest. Permissionless and",
        "write-once per statement; every stored field comes from the proven journal."
      ],
      "discriminator": [
        142,
        198,
        171,
        156,
        13,
        229,
        30,
        16
      ],
      "accounts": [
        {
          "name": "score",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  101,
                  114,
                  105,
                  102,
                  105,
                  101,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "statementHash"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "suite",
          "docs": [
            "Owner + discriminator checked by Account; commitment checked in the handler (suite PDAs are",
            "only ever created at [\"suite\", commitment])."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "submitter",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
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
          "name": "seal",
          "type": "bytes"
        },
        {
          "name": "journal",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "registerSuite",
      "docs": [
        "Register a test suite by its commitment. The signer becomes its author.",
        "`price_mint == None` means the price is in lamports; otherwise it is in that SPL mint",
        "(e.g. USDC), in the mint's base units."
      ],
      "discriminator": [
        113,
        118,
        85,
        117,
        77,
        133,
        176,
        218
      ],
      "accounts": [
        {
          "name": "suite",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  105,
                  116,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "suiteCommitment"
              }
            ]
          }
        },
        {
          "name": "author",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
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
          "name": "price",
          "type": "u64"
        },
        {
          "name": "priceMint",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "setConfig",
      "docs": [
        "Admin-only: rotate the trusted guest image, root, enclave compose hash or TD image."
      ],
      "discriminator": [
        108,
        158,
        154,
        175,
        212,
        98,
        52,
        66
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "imageId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "rootSha256",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "composeHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "mrTd",
          "type": {
            "array": [
              "u8",
              48
            ]
          }
        }
      ]
    },
    {
      "name": "setSuitePrice",
      "docs": [
        "Author-only price change."
      ],
      "discriminator": [
        134,
        46,
        56,
        122,
        231,
        13,
        70,
        248
      ],
      "accounts": [
        {
          "name": "suite",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  105,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "suite.suite_commitment",
                "account": "suite"
              }
            ]
          }
        },
        {
          "name": "author",
          "signer": true,
          "relations": [
            "suite"
          ]
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "priceMint",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "scoreRecord",
      "discriminator": [
        245,
        238,
        28,
        93,
        123,
        218,
        89,
        119
      ]
    },
    {
      "name": "suite",
      "discriminator": [
        121,
        38,
        87,
        202,
        248,
        217,
        33,
        123
      ]
    },
    {
      "name": "verifiedScore",
      "discriminator": [
        191,
        249,
        181,
        148,
        69,
        3,
        1,
        222
      ]
    }
  ],
  "events": [
    {
      "name": "configSet",
      "discriminator": [
        15,
        104,
        59,
        16,
        236,
        241,
        8,
        6
      ]
    },
    {
      "name": "scoreRecorded",
      "discriminator": [
        49,
        189,
        142,
        188,
        114,
        203,
        130,
        97
      ]
    },
    {
      "name": "suitePriceSet",
      "discriminator": [
        139,
        43,
        125,
        123,
        51,
        158,
        1,
        197
      ]
    },
    {
      "name": "suiteRegistered",
      "discriminator": [
        179,
        120,
        213,
        142,
        112,
        29,
        253,
        55
      ]
    },
    {
      "name": "verifiedScoreRecorded",
      "discriminator": [
        247,
        75,
        64,
        19,
        13,
        145,
        173,
        222
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
      "name": "badScore",
      "msg": "score must have total > 0 and correct <= total"
    },
    {
      "code": 6002,
      "name": "badBindingVersion",
      "msg": "binding_version must be 1 or 2"
    },
    {
      "code": 6003,
      "name": "suiteMismatch",
      "msg": "suite account does not match suite_commitment"
    },
    {
      "code": 6004,
      "name": "notAuthor",
      "msg": "only the suite author / config admin can do this"
    },
    {
      "code": 6005,
      "name": "notUpgradeAuthority",
      "msg": "only the program's upgrade authority can initialise the config"
    },
    {
      "code": 6006,
      "name": "badJournal",
      "msg": "journal has the wrong length"
    },
    {
      "code": 6007,
      "name": "journalMismatch",
      "msg": "statement_hash argument does not match the journal"
    },
    {
      "code": 6008,
      "name": "quoteNotBound",
      "msg": "the TDX quote's report_data does not commit to this statement"
    },
    {
      "code": 6009,
      "name": "wrongRoot",
      "msg": "the guest pinned a different root certificate than the config requires"
    },
    {
      "code": 6010,
      "name": "wrongEnclave",
      "msg": "the score did not come from the approved enclave (compose hash or mr_td)"
    },
    {
      "code": 6011,
      "name": "badProof",
      "msg": "Groth16 proof does not verify for the configured guest image and this journal"
    }
  ],
  "types": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "imageId",
            "docs": [
              "RISC Zero image id of the trusted sealed-eval guest build."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "rootSha256",
            "docs": [
              "sha256 of the root certificate the guest must have pinned."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "composeHash",
            "docs": [
              "dstack app compose hash of the approved enclave (the measured docker-compose)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mrTd",
            "docs": [
              "Approved TD image measurement; all zero = not checked."
            ],
            "type": {
              "array": [
                "u8",
                48
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "configSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "imageId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "rootSha256",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "composeHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mrTd",
            "type": {
              "array": [
                "u8",
                48
              ]
            }
          }
        ]
      }
    },
    {
      "name": "scoreRecord",
      "type": {
        "kind": "struct",
        "fields": [
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
            "name": "suiteCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "quoteHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mrTd",
            "type": {
              "array": [
                "u8",
                48
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
            "name": "bindingVersion",
            "docs": [
              "1 = tessera:score:v1 (CPU TDX), 2 = tessera:score:v2 (TDX + NVIDIA GPU report)"
            ],
            "type": "u8"
          },
          {
            "name": "suiteRegistered",
            "type": "bool"
          },
          {
            "name": "submitter",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "unixTimestamp",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "scoreRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "score",
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
            "name": "suiteCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "quoteHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mrTd",
            "type": {
              "array": [
                "u8",
                48
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
            "name": "bindingVersion",
            "type": "u8"
          },
          {
            "name": "submitter",
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
      "name": "suite",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "author",
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
            "name": "price",
            "docs": [
              "Price to buy access to / run against this suite. Unit set by `price_mint`."
            ],
            "type": "u64"
          },
          {
            "name": "priceMint",
            "docs": [
              "None = lamports, Some(mint) = SPL token (e.g. USDC) base units."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "scoreCount",
            "type": "u64"
          },
          {
            "name": "createdSlot",
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
      "name": "suitePriceSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "suite",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "priceMint",
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "suiteRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "suite",
            "type": "pubkey"
          },
          {
            "name": "author",
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
            "name": "price",
            "type": "u64"
          },
          {
            "name": "priceMint",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "verifiedScore",
      "docs": [
        "A score whose TDX quote was verified (to `root_sha256` of the config at the time) in a proven",
        "guest run, and whose quote report_data commits to the statement."
      ],
      "type": {
        "kind": "struct",
        "fields": [
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
            "name": "suiteCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "quoteHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mrTd",
            "type": {
              "array": [
                "u8",
                48
              ]
            }
          },
          {
            "name": "rtmrsHash",
            "docs": [
              "sha256(rtmr0..3): runtime measurements (for dstack, RTMR3 covers the compose hash)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "teeTcbSvn",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "composeHash",
            "docs": [
              "dstack app compose hash of the enclave that produced the score (equals the config's)."
            ],
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
            "name": "bindingVersion",
            "type": "u8"
          },
          {
            "name": "imageId",
            "docs": [
              "Guest image that produced the proof."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "suiteRegistered",
            "type": "bool"
          },
          {
            "name": "submitter",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "unixTimestamp",
            "type": "i64"
          },
          {
            "name": "payout",
            "docs": [
              "Entrant's payout address, proven inside the statement; all zero if the statement had none."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "verifiedScoreRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "score",
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
            "name": "suiteCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mrTd",
            "type": {
              "array": [
                "u8",
                48
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
            "name": "imageId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "submitter",
            "type": "pubkey"
          },
          {
            "name": "payout",
            "type": "pubkey"
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
