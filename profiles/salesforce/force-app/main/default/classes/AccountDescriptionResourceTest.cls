// Platform tests for W03-SF: permitted update, denied update, stale-version conflict, missing input.
// Personas get only the lab permission sets on top of the Minimum Access profile.
@IsTest
private class AccountDescriptionResourceTest {
    private static User persona(String permissionSet, String key) {
        Profile minimal = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1];
        String unique = key + '.' + String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        User u = new User(
            Username = 'apl.' + unique + '@agent-proof-lab.invalid',
            Email = 'apl.' + key + '@agent-proof-lab.invalid',
            LastName = 'Persona ' + key, Alias = key.left(8), ProfileId = minimal.Id,
            TimeZoneSidKey = 'GMT', LocaleSidKey = 'en_US', EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US');
        insert u;
        insert new PermissionSetAssignment(
            AssigneeId = u.Id,
            PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = :permissionSet LIMIT 1].Id);
        return u;
    }

    private static Map<String, User> personas() {
        Map<String, User> users = new Map<String, User>();
        // Setup-object DML in its own runAs block avoids mixed-DML errors with the Account insert.
        System.runAs(new User(Id = UserInfo.getUserId())) {
            users.put('writer', persona('APL_Writer', 'writer'));
            users.put('readonly', persona('APL_ReadOnly', 'readonly'));
        }
        return users;
    }

    private static Account seed(Id ownerId) {
        Account a = new Account(Name = 'Northstar Demo', Description = 'Trial account',
            APL_Description_Version__c = 1, OwnerId = ownerId);
        insert a;
        return a;
    }

    private static Account reread(Id id) {
        return [SELECT Description, APL_Description_Version__c FROM Account WHERE Id = :id];
    }

    @IsTest
    static void writerUpdatesWhenVersionMatches() {
        Map<String, User> users = personas();
        Account a = seed(users.get('writer').Id);
        AccountDescriptionResource.Result r;
        System.runAs(users.get('writer')) {
            r = AccountDescriptionResource.apply(a.Id, 'Workshop follow-up requested', 1);
        }
        Assert.areEqual('UPDATED', r.outcome);
        Assert.areEqual(2, r.version);
        Account after = reread(a.Id);
        Assert.areEqual('Workshop follow-up requested', after.Description);
        Assert.areEqual(2, after.APL_Description_Version__c.intValue());
    }

    @IsTest
    static void readOnlyPersonaIsDenied() {
        Map<String, User> users = personas();
        Account a = seed(users.get('readonly').Id);
        AccountDescriptionResource.Result r;
        System.runAs(users.get('readonly')) {
            r = AccountDescriptionResource.apply(a.Id, 'Workshop follow-up requested', 1);
        }
        Assert.areEqual('DENIED', r.outcome);
        Account after = reread(a.Id);
        Assert.areEqual('Trial account', after.Description);
        Assert.areEqual(1, after.APL_Description_Version__c.intValue());
    }

    @IsTest
    static void staleVersionConflictsWithoutOverwrite() {
        Map<String, User> users = personas();
        Account a = seed(users.get('writer').Id);
        AccountDescriptionResource.Result first;
        AccountDescriptionResource.Result stale;
        System.runAs(users.get('writer')) {
            first = AccountDescriptionResource.apply(a.Id, 'Workshop follow-up requested', 1);
            stale = AccountDescriptionResource.apply(a.Id, 'Overwrite attempt', 1);
        }
        Assert.areEqual('UPDATED', first.outcome);
        Assert.areEqual('CONFLICT', stale.outcome);
        Assert.areEqual(2, stale.version);
        Assert.areEqual('Workshop follow-up requested', reread(a.Id).Description);
    }

    @IsTest
    static void missingExpectedVersionIsInvalid() {
        Map<String, User> users = personas();
        Account a = seed(users.get('writer').Id);
        AccountDescriptionResource.Result r;
        System.runAs(users.get('writer')) {
            r = AccountDescriptionResource.apply(a.Id, 'Workshop follow-up requested', null);
        }
        Assert.areEqual('INVALID', r.outcome);
        Assert.areEqual('Trial account', reread(a.Id).Description);
    }
}
