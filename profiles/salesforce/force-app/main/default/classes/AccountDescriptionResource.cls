// Compare-and-write on a synthetic Account description (W03 / F5-R2).
// Sharing, CRUD and FLS are enforced explicitly; APL_Description_Version__c is a semantic version, not a native one.
@RestResource(urlMapping='/apl/account-description')
global with sharing class AccountDescriptionResource {
    global class Result {
        global String outcome;   // UPDATED | CONFLICT | DENIED | NOT_FOUND | INVALID
        global Integer version;  // current version after the call, when readable
        global String message;
    }

    @HttpPatch
    global static Result updateDescription(String accountId, String description, Integer expectedVersion) {
        Result r = apply(accountId, description, expectedVersion);
        if (RestContext.response != null) {
            Map<String, Integer> codes = new Map<String, Integer>{
                'UPDATED' => 200, 'CONFLICT' => 409, 'DENIED' => 403, 'NOT_FOUND' => 404, 'INVALID' => 400 };
            RestContext.response.statusCode = codes.get(r.outcome);
        }
        return r;
    }

    public static Result apply(String accountId, String description, Integer expectedVersion) {
        if (String.isBlank(accountId) || description == null || expectedVersion == null) {
            return result('INVALID', null, 'accountId, description and expectedVersion are required');
        }
        if (!Schema.sObjectType.Account.isUpdateable()
            || !Schema.sObjectType.Account.fields.Description.isUpdateable()
            || !Schema.sObjectType.Account.fields.APL_Description_Version__c.isUpdateable()) {
            return result('DENIED', null, 'Caller lacks edit permission on Account.Description');
        }
        List<Account> rows = [
            SELECT Id, APL_Description_Version__c FROM Account
            WHERE Id = :accountId WITH USER_MODE LIMIT 1 FOR UPDATE
        ];
        if (rows.isEmpty()) {
            return result('NOT_FOUND', null, 'Account not visible to caller');
        }
        Account row = rows[0];
        Integer current = row.APL_Description_Version__c == null ? null : row.APL_Description_Version__c.intValue();
        if (current == null || current != expectedVersion) {
            return result('CONFLICT', current, 'Expected version is stale; nothing written');
        }
        row.Description = description;
        row.APL_Description_Version__c = current + 1;
        try {
            Database.update(row, AccessLevel.USER_MODE);
        } catch (Exception e) {
            return result('DENIED', current, 'Platform refused the update');
        }
        return result('UPDATED', current + 1, 'Description updated');
    }

    private static Result result(String outcome, Integer version, String message) {
        Result r = new Result();
        r.outcome = outcome;
        r.version = version;
        r.message = message;
        return r;
    }
}
