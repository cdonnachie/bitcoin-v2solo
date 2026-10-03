use rand::thread_rng;
use secp256k1::{Keypair, Secp256k1};

fn main() {
    let secp = Secp256k1::new();
    let keypair = Keypair::new(&secp, &mut thread_rng());
    let (public_key, _) = keypair.x_only_public_key();
    let mut versioned_public_key = Vec::with_capacity(34);
    versioned_public_key.extend_from_slice(&1_u16.to_le_bytes());
    versioned_public_key.extend_from_slice(&public_key.serialize());

    println!(
        "POOL__AUTHORITY_PUBLIC_KEY={}",
        bs58::encode(versioned_public_key).with_check().into_string()
    );
    println!(
        "POOL__AUTHORITY_SECRET_KEY={}",
        bs58::encode(keypair.secret_key().secret_bytes())
            .with_check()
            .into_string()
    );
}