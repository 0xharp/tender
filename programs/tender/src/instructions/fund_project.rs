use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as sysvar_ix;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, BuyerReputationUpdated, Escrow, ESCROW_SEED, MilestoneState,
    MILESTONE_SEED, MilestoneStatus, Rfp, RfpFunded, RfpStatus, SPLIT_NOT_PROPOSED,
};

/// Solana's built-in Ed25519 signature verification program.
/// Address: `Ed25519SigVerify111111111111111111111111111`. Same constant
/// the select_bid binding-sig flow pins; duplicated here to avoid a
/// cross-module import while we hold off on the broader extract-shared-
/// helpers refactor.
pub const ED25519_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39,
    244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
]);

/// Domain prefix the buyer signs to authorize a fund_project tx. Same
/// string also used client-side to construct the message before signing.
pub const FUND_AUTH_DOMAIN: &[u8] = b"tender-fund-auth-v1";

/// Buyer locks the full contract_value into escrow + initializes all milestone
/// PDAs at amounts derived from `rfp.milestone_percentages`.
///
/// Must be called within `rfp.funding_deadline`. After this ix:
///   - rfp.status = Funded
///   - escrow ATA holds contract_value of mint
///   - all milestones exist in Pending status with their target amounts
///
/// Funder/buyer split (v2): `funder` signs the tx + supplies the source ATA.
/// `buyer` is read-only — its identity is verified by an `Ed25519SigVerify`
/// ix earlier in the same tx, signing a canonical fund-authorization message
/// with `rfp.buyer`'s pubkey. This decouples the on-chain trail of the
/// funding deposit from the buyer's main wallet:
///   - Public buyer mode: funder = buyer (same wallet); sigverify ix is
///     authored by the same wallet that signs the tx envelope. Equivalent
///     to today's behavior, with one extra signature.
///   - Private buyer mode: rfp.buyer is an HD-derived ephemeral; funder is
///     a Cloak-shielded ephemeral that drained from the buyer's main
///     treasury. The ephemeral_buyer signs the sigverify message; the
///     ephemeral_funder signs the tx + supplies the source ATA. Buyer's
///     main wallet never appears in any on-chain trail of this RFP.
///
/// Note: this ix uses bare `init` on the milestone PDAs (via remaining_accounts)
/// so it's idempotent at the milestone-init layer. The token transfer is NOT
/// idempotent - calling twice would attempt to transfer twice. Status check
/// (must be Awarded) blocks double-fund.
#[derive(Accounts)]
#[instruction()]
pub struct FundProject<'info> {
    /// Pays tx fee + ATA/escrow rent + provides the source token account.
    /// Decoupled from `buyer` (v2) so a Cloak-shielded ephemeral can settle
    /// the deposit without on-chain link to the buyer's main wallet.
    #[account(mut)]
    pub funder: Signer<'info>,

    /// Read-only reference to whoever the program treats as the buyer
    /// (`rfp.buyer`). Verified two ways:
    ///   1. Anchor's `has_one = buyer` on the rfp account
    ///   2. The Ed25519SigVerify ix in this tx must sign the canonical
    ///      `tender-fund-auth-v1` message with this pubkey
    /// CHECK: pure read; no data deserialization.
    pub buyer: AccountInfo<'info>,

    /// `Box<Account>` for the same stack-frame reason as before.
    #[account(
        mut,
        has_one = buyer @ TenderError::NotBuyer,
    )]
    pub rfp: Box<Account<'info, Rfp>>,

    pub mint: Box<Account<'info, Mint>>,

    /// Source ATA: funder's USDC. (v2 — was buyer's ATA. In private
    /// buyer mode, the funder ephemeral receives USDC from a Cloak
    /// shielded withdraw before signing this tx.)
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = funder,
    )]
    pub funder_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = funder,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, rfp.key().as_ref()],
        bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,

    /// Escrow ATA: the PDA that will hold the locked USDC. (v2 — funder
    /// pays rent; same destination as before.)
    #[account(
        init,
        payer = funder,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub escrow_ata: Box<Account<'info, TokenAccount>>,

    /// Buyer reputation PDA — keyed on `rfp.buyer` regardless of mode.
    /// In public mode this is the buyer's main wallet rep (today's
    /// behavior). In private mode this is the ephemeral's stranded
    /// rep PDA: it gets the increment but nobody ever reads it; the
    /// buyer can later opt to merge it into their main rep via
    /// `attest_buyer_history`.
    #[account(
        mut,
        seeds = [BUYER_REP_SEED, buyer.key().as_ref()],
        bump = buyer_reputation.bump,
    )]
    pub buyer_reputation: Box<Account<'info, BuyerReputation>>,

    /// CHECK: instructions sysvar - we only read it via the
    /// `sysvar_ix` helpers, which validate its address. Required to
    /// introspect the Ed25519SigVerify ix.
    #[account(address = sysvar_ix::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[qedgen_macros::qed(verified, spec = "../../tender.qedspec", handler = "fund_project", hash = "87322ceee06585d7", spec_hash = "47e5a6cfaf18304e", accounts = "FundProject", accounts_file = "src/instructions/fund_project.rs", accounts_hash = "b36b8ff2e7770e5e")]
pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, FundProject<'info>>) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(rfp.status == RfpStatus::Awarded, TenderError::InvalidRfpStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now <= rfp.funding_deadline, TenderError::FundingWindowExpired);

    let contract_value = rfp.contract_value;
    require!(contract_value > 0, TenderError::DeclaredAmountMismatch);

    // v2 — verify the Ed25519SigVerify ix earlier in this tx signs the
    // canonical fund-authorization message with `rfp.buyer`'s pubkey.
    // This proves the buyer authorized THIS specific fund tx, even when
    // a different wallet (funder) is the tx signer.
    verify_fund_authorization(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.buyer.key(),
        &rfp.key(),
        contract_value,
    )?;

    // Initialize escrow.
    let escrow = &mut ctx.accounts.escrow;
    escrow.rfp = rfp.key();
    escrow.mint = ctx.accounts.mint.key();
    escrow.total_locked = contract_value;
    escrow.total_released = 0;
    escrow.total_refunded = 0;
    escrow.bump = ctx.bumps.escrow;
    escrow.funded_at = now;

    // Move USDC from FUNDER's ATA to escrow ATA. (v2 — was buyer_ata
    // owned by buyer; now funder_ata owned by funder. Authority must
    // be the signer of the tx, hence funder.)
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.funder_ata.to_account_info(),
        to: ctx.accounts.escrow_ata.to_account_info(),
        authority: ctx.accounts.funder.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    transfer_checked(cpi_ctx, contract_value, ctx.accounts.mint.decimals)?;

    // Initialize each milestone PDA. We need to do this via remaining_accounts
    // because we don't know how many milestones there are at compile time.
    // remaining_accounts layout: [ms_0, ms_1, ..., ms_{milestone_count-1}].
    // (v2 — funder pays rent for each, since funder is the tx signer.)
    let remaining = &ctx.remaining_accounts;
    require!(remaining.len() == rfp.milestone_count as usize, TenderError::InvalidMilestoneCount);

    for (i, ms_account_info) in remaining.iter().enumerate() {
        let amount = rfp.milestone_amounts[i];

        // Verify the PDA derivation.
        let (expected_pda, bump) = Pubkey::find_program_address(
            &[MILESTONE_SEED, rfp.key().as_ref(), &[i as u8]],
            &crate::ID,
        );
        require_keys_eq!(*ms_account_info.key, expected_pda, TenderError::InvalidMilestoneIndex);

        // Create the account via system_program CPI with PDA signer.
        let space = 8 + MilestoneState::INIT_SPACE;
        let lamports = Rent::get()?.minimum_balance(space);
        let rfp_key = rfp.key();
        let signer_seeds: &[&[u8]] = &[MILESTONE_SEED, rfp_key.as_ref(), &[i as u8], &[bump]];

        let create_ix = anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.funder.key(),
            &expected_pda,
            lamports,
            space as u64,
            &crate::ID,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &create_ix,
            &[
                ctx.accounts.funder.to_account_info(),
                ms_account_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;

        // Write initial state. delivery_deadline stays 0 here; start_milestone
        // sets it once the provider commits.
        let ms = MilestoneState {
            rfp: rfp.key(),
            index: i as u8,
            amount,
            status: MilestoneStatus::Pending,
            iteration_count: 0,
            started_at: 0,
            submitted_at: 0,
            review_deadline: 0,
            disputed_at: 0,
            dispute_deadline: 0,
            bump,
            buyer_proposed_split_bps: SPLIT_NOT_PROPOSED,
            provider_proposed_split_bps: SPLIT_NOT_PROPOSED,
            delivery_deadline: 0,
        };
        let mut data = ms_account_info.try_borrow_mut_data()?;
        // Anchor account discriminator first 8 bytes.
        data[..8].copy_from_slice(&MilestoneState::DISCRIMINATOR);
        let mut cursor: &mut [u8] = &mut data[8..];
        ms.serialize(&mut cursor)?;
    }

    rfp.status = RfpStatus::Funded;

    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    buyer_rep.funded_rfps = buyer_rep.funded_rfps.checked_add(1).ok_or(TenderError::MathOverflow)?;
    buyer_rep.last_updated = now;
    emit!(BuyerReputationUpdated { buyer: buyer_rep.buyer, field: 1, at: now });

    emit!(RfpFunded {
        rfp: rfp.key(),
        buyer: rfp.buyer,
        funder: ctx.accounts.funder.key(),
        contract_value,
        funded_at: now,
    });
    Ok(())
}

/// Verify the Ed25519SigVerify ix immediately before fund_project signs the
/// canonical fund-authorization message with `expected_signer` (= rfp.buyer).
///
/// Layout + scanning convention mirror `select_bid::verify_binding_signature`
/// (programs/tender/src/instructions/select_bid.rs:241): walk relative to
/// `current_index - 1`, validate Ed25519 single-signature ix layout, compare
/// pubkey + message bytes exactly.
///
/// Canonical message format (the same string the client signs):
///
/// ```text
/// tender-fund-auth-v1
/// program=<id>
/// rfp=<rfp_pda>
/// contract_value=<u64_decimal>
/// ```
///
/// Decimal `contract_value` (not LE bytes) keeps the message human-readable
/// in the wallet popup, matching the select_bid pattern.
fn verify_fund_authorization(
    instructions_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
    rfp_pda: &Pubkey,
    contract_value: u64,
) -> Result<()> {
    let current_index = sysvar_ix::load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(TenderError::InvalidAttestation))?;
    require!(current_index > 0, TenderError::InvalidAttestation);
    let ix0 = sysvar_ix::load_instruction_at_checked(
        (current_index - 1) as usize,
        instructions_sysvar,
    )
    .map_err(|_| error!(TenderError::InvalidAttestation))?;
    require_keys_eq!(ix0.program_id, ED25519_PROGRAM_ID, TenderError::InvalidAttestation);

    // Ed25519SigVerify single-signature data layout — see
    // `select_bid::verify_binding_signature` for the byte-level comments.
    let data = &ix0.data;
    require!(data.len() >= 16 + 64 + 32, TenderError::InvalidAttestation);
    require!(data[0] == 1, TenderError::InvalidAttestation);

    fn u16_le(b: &[u8], o: usize) -> u16 {
        u16::from_le_bytes([b[o], b[o + 1]])
    }
    let sig_offset = u16_le(data, 2);
    let sig_ix_index = u16_le(data, 4);
    let pubkey_offset = u16_le(data, 6);
    let pubkey_ix_index = u16_le(data, 8);
    let msg_offset = u16_le(data, 10);
    let msg_size = u16_le(data, 12);
    let msg_ix_index = u16_le(data, 14);

    require!(sig_offset == 16, TenderError::InvalidAttestation);
    require!(pubkey_offset == 80, TenderError::InvalidAttestation);
    require!(msg_offset == 112, TenderError::InvalidAttestation);
    require!(sig_ix_index == u16::MAX, TenderError::InvalidAttestation);
    require!(pubkey_ix_index == u16::MAX, TenderError::InvalidAttestation);
    require!(msg_ix_index == u16::MAX, TenderError::InvalidAttestation);
    require!(data.len() == 112 + msg_size as usize, TenderError::InvalidAttestation);

    // Pubkey must match rfp.buyer.
    let signed_pubkey: [u8; 32] = data[80..112].try_into().unwrap();
    require!(signed_pubkey == expected_signer.to_bytes(), TenderError::InvalidAttestation);

    // Message must be the canonical fund-authorization string for this
    // (rfp_pda, contract_value).
    let actual_message = &data[112..112 + msg_size as usize];
    let expected = build_fund_auth_message(rfp_pda, contract_value);
    require!(actual_message == expected.as_slice(), TenderError::InvalidAttestation);

    Ok(())
}

fn build_fund_auth_message(rfp: &Pubkey, contract_value: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(160);
    out.extend_from_slice(FUND_AUTH_DOMAIN);
    out.push(b'\n');
    out.extend_from_slice(b"program=");
    out.extend_from_slice(bs58_encode(&crate::ID.to_bytes()).as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"rfp=");
    out.extend_from_slice(bs58_encode(&rfp.to_bytes()).as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"contract_value=");
    out.extend_from_slice(contract_value.to_string().as_bytes());
    out
}

/// Minimal base58 encoder — duplicated from select_bid to keep this file
/// self-contained until we extract shared utils. Same algorithm; 32-byte
/// pubkeys always encode to 43-44 chars.
fn bs58_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = vec![0];
    for &b in input {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    // Leading-zero bytes → leading '1's in base58.
    let mut leading_zeros = 0usize;
    for &b in input {
        if b == 0 {
            leading_zeros += 1;
        } else {
            break;
        }
    }
    let mut out = String::with_capacity(leading_zeros + digits.len());
    for _ in 0..leading_zeros {
        out.push('1');
    }
    for d in digits.iter().rev() {
        out.push(ALPHABET[*d as usize] as char);
    }
    out
}
