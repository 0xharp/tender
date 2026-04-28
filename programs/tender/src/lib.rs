use anchor_lang::prelude::*;

declare_id!("Tender1111111111111111111111111111111111111");

#[program]
pub mod tender {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("tender: ping");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub signer: Signer<'info>,
}
